import {
  Controller,
  Post,
  Req,
  Headers,
  BadRequestException,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service.js';
import { StripeService } from '../stripe/stripe.service.js';

// Терминальные статусы — оплата по ним не должна подтверждать бронь.
const TERMINAL_STATUSES: readonly string[] = [
  'EXPIRED',
  'CANCELLED_BY_GUEST',
  'CANCELLED_BY_HOST',
];

@Controller('webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);
  private readonly stripe: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
  ) {
    this.stripe = this.stripeService.client;
  }

  @Post('stripe')
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    let event: Stripe.Event;

    // 1. Проверка подписи — обязательно по raw body.
    try {
      event = this.stripe.webhooks.constructEvent(
        req.rawBody!,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      this.logger.error(`Webhook signature verification failed: ${message}`);
      throw new BadRequestException(`Webhook Error: ${message}`);
    }

    this.logger.log(`Received Stripe event: ${event.type} (id: ${event.id})`);

    // 2. Идемпотентность.
    const existingEvent = await this.prisma.stripeWebhookEvent.findUnique({
      where: { eventId: event.id },
    });
    if (existingEvent?.processed) {
      this.logger.log(`Event ${event.id} already processed, skipping`);
      return { received: true };
    }

    // 3. Сохраняем событие.
    await this.prisma.stripeWebhookEvent.upsert({
      where: { eventId: event.id },
      create: {
        eventId: event.id,
        type: event.type,
        payload: event.data.object as object,
        processed: false,
      },
      update: {
        type: event.type,
        payload: event.data.object as object,
      },
    });

    // 4. Обработка по типу.
    try {
      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          await this.handleCheckoutCompleted(event);
          break;

        case 'checkout.session.expired':
          await this.handleCheckoutExpired(event);
          break;

        case 'payment_intent.payment_failed':
          await this.handlePaymentFailed(event);
          break;

        case 'refund.created':
        case 'refund.updated':
          await this.handleRefundUpdated(event);
          break;

        // Алиас: charge.refunded тоже несёт refund-информацию
        case 'charge.refunded':
          await this.handleChargeRefunded(event);
          break;

        default:
          this.logger.log(`Unhandled event type: ${event.type}`);
      }

      // 5. Отмечаем как обработанное.
      await this.prisma.stripeWebhookEvent.update({
        where: { eventId: event.id },
        data: { processed: true, processedAt: new Date() },
      });

      this.logger.log(`Successfully processed event: ${event.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const stack = err instanceof Error ? err.stack : undefined;

      await this.prisma.stripeWebhookEvent.update({
        where: { eventId: event.id },
        data: { processed: false, error: message },
      });

      this.logger.error(
        `Failed to process event ${event.id}: ${message}`,
        stack,
      );
      throw new BadRequestException(`Processing failed: ${message}`);
    }

    return { received: true };
  }

  /**
   * checkout.session.completed / async_payment_succeeded.
   * Подтверждает бронь. Если бронь уже терминальная — возвращает деньги.
   */
  private async handleCheckoutCompleted(event: Stripe.Event) {
    const session = event.data.object as Stripe.Checkout.Session;
    const bookingId = session.metadata?.bookingId;

    if (!bookingId) {
      this.logger.warn(`checkout.session.completed: no bookingId in metadata`);
      return;
    }

    // Расширяем сессию, чтобы получить payment_intent и charge.
    const expandedSession = await this.stripe.checkout.sessions.retrieve(
      session.id,
      { expand: ['payment_intent'] },
    );

    const paymentIntent =
      expandedSession.payment_intent as Stripe.PaymentIntent | null;
    const paymentIntentId =
      typeof expandedSession.payment_intent === 'string'
        ? expandedSession.payment_intent
        : (paymentIntent?.id ?? null);
    const chargeId = paymentIntent?.latest_charge as string | null;

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });
    if (!booking) {
      this.logger.warn(
        `checkout.session.completed: booking ${bookingId} not found`,
      );
      return;
    }

    // Если бронь уже терминальная — оплата пришла поздно. Возвращаем деньги.
    if (TERMINAL_STATUSES.includes(booking.status)) {
      this.logger.warn(
        `Payment for terminal booking ${bookingId} (status=${booking.status}) — refunding`,
      );
      await this.refundLatePayment(bookingId, paymentIntentId, expandedSession);
      return;
    }

    if (booking.status === 'CONFIRMED') {
      this.logger.log(`Booking ${bookingId} already confirmed, skipping`);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      });

      // Обновляем платёж по checkoutSessionId из metadata.
      const updated = await tx.payment.updateMany({
        where: {
          bookingId,
          metadata: { path: ['checkoutSessionId'], equals: session.id },
        },
        data: {
          status: 'SUCCEEDED',
          paidAt: new Date(),
          stripeChargeId: chargeId ?? paymentIntentId,
          stripePaymentIntentId: paymentIntentId,
          stripeCustomerId: (expandedSession.customer as string) ?? undefined,
          method: paymentIntent?.payment_method_types?.[0] ?? 'card',
        },
      });

      // Если платежа не было — создаём.
      if (updated.count === 0) {
        await tx.payment.create({
          data: {
            bookingId,
            userId: booking.guestId,
            amount: booking.totalAmount,
            currency: booking.currency,
            status: 'SUCCEEDED',
            paidAt: new Date(),
            stripePaymentIntentId: paymentIntentId,
            stripeChargeId: chargeId ?? paymentIntentId,
            stripeCustomerId: (expandedSession.customer as string) ?? undefined,
            method: paymentIntent?.payment_method_types?.[0] ?? 'card',
            metadata: { checkoutSessionId: session.id, recovered: true },
          },
        });
      }

      await tx.notification.create({
        data: {
          userId: booking.guestId,
          type: 'BOOKING_CONFIRMED',
          channel: 'EMAIL',
          title: 'Бронирование подтверждено',
          body: `Ваша оплата прошла успешно. Бронь #${booking.code} подтверждена.`,
          data: { bookingId },
        },
      });

      this.logger.log(
        `Booking ${bookingId} confirmed via checkout.session.completed`,
      );
    });
  }

  /**
   * checkout.session.expired — гость не оплатил.
   */
  private async handleCheckoutExpired(event: Stripe.Event) {
    const session = event.data.object as Stripe.Checkout.Session;
    const bookingId = session.metadata?.bookingId;

    if (!bookingId) return;

    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.booking.updateMany({
        where: { id: bookingId, status: 'PENDING' },
        data: { status: 'EXPIRED' },
      });

      await tx.payment.updateMany({
        where: {
          bookingId,
          status: 'PENDING',
          metadata: { path: ['checkoutSessionId'], equals: session.id },
        },
        data: { status: 'FAILED', failureReason: 'Checkout session expired' },
      });

      if (updated.count > 0) {
        const booking = await tx.booking.findUnique({
          where: { id: bookingId },
        });
        if (booking) {
          await tx.notification.create({
            data: {
              userId: booking.guestId,
              type: 'PAYMENT_FAILED',
              channel: 'IN_APP',
              title: 'Срок оплаты истек',
              body: `Время на оплату брони #${booking.code} истекло. Бронь отменена.`,
              data: { bookingId },
            },
          });
        }
      }

      this.logger.log(
        `Booking ${bookingId} expired (checkout.session.expired)`,
      );
    });
  }

  /**
   * payment_intent.payment_failed — оплата не прошла.
   */
  private async handlePaymentFailed(event: Stripe.Event) {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;

    let bookingId: string | undefined = paymentIntent.metadata?.bookingId;
    if (!bookingId) {
      const payment = await this.prisma.payment.findFirst({
        where: { stripePaymentIntentId: paymentIntent.id },
        select: { bookingId: true },
      });
      bookingId = payment?.bookingId;
    }

    if (!bookingId) {
      this.logger.warn(
        `payment_intent.payment_failed: cannot resolve bookingId for ${paymentIntent.id}`,
      );
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: { stripePaymentIntentId: paymentIntent.id },
        data: {
          status: 'FAILED',
          failureReason:
            paymentIntent.last_payment_error?.message ?? 'Payment failed',
        },
      });

      const booking = await tx.booking.findUnique({
        where: { id: bookingId },
      });

      if (booking?.status === 'PENDING') {
        await tx.notification.create({
          data: {
            userId: booking.guestId,
            type: 'PAYMENT_FAILED',
            channel: 'IN_APP',
            title: 'Оплата не прошла',
            body: `Оплата за бронь #${booking.code} не удалась. Попробуйте снова.`,
            data: { bookingId },
          },
        });
      }

      this.logger.log(
        `Payment failed for booking ${bookingId}: ${paymentIntent.last_payment_error?.message}`,
      );
    });
  }

  /**
   * refund.created / refund.updated — обновляем статус возврата
   * и связанного платежа.
   */
  private async handleRefundUpdated(event: Stripe.Event) {
    const refund = event.data.object as Stripe.Refund;
    const bookingId = refund.metadata?.bookingId;

    if (!bookingId) {
      this.logger.warn(
        `${event.type}: no bookingId in refund metadata (refundId=${refund.id})`,
      );
      return;
    }

    const refundStatus =
      refund.status === 'succeeded'
        ? 'PROCESSED'
        : refund.status === 'failed'
          ? 'REJECTED'
          : 'REQUESTED';

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.refund.findFirst({
        where: { stripeRefundId: refund.id },
      });

      if (existing) {
        await tx.refund.update({
          where: { id: existing.id },
          data: {
            status: refundStatus,
            processedAt: refundStatus === 'PROCESSED' ? new Date() : null,
            adminNote: refund.failure_reason ?? existing.adminNote,
          },
        });
      } else {
        this.logger.warn(
          `${event.type}: refund ${refund.id} not found in DB for booking ${bookingId}`,
        );
      }

      if (refundStatus === 'PROCESSED') {
        const payment = await tx.payment.findFirst({
          where: { bookingId },
          orderBy: { createdAt: 'desc' },
        });
        if (payment) {
          const isFullRefund = refund.amount >= payment.amount;
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
            },
          });
        }
      }

      this.logger.log(
        `Refund ${refund.id} (${event.type}) → ${refundStatus} for booking ${bookingId}`,
      );
    });
  }

  /**
   * charge.refunded — алиас на refund.updated.
   * В charge.refunded объект — Charge, у которого есть refunded/amount_refunded,
   * но нет refund.metadata. Ищем refund по chargeId.
   */
  private async handleChargeRefunded(event: Stripe.Event) {
    const charge = event.data.object as Stripe.Charge;

    // Ищем платёж по chargeId, чтобы найти bookingId.
    const payment = await this.prisma.payment.findFirst({
      where: { stripeChargeId: charge.id },
      select: { bookingId: true },
    });

    if (!payment) {
      this.logger.warn(
        `charge.refunded: no payment found for charge ${charge.id}`,
      );
      return;
    }

    // charge.refunded приходит один раз, даже если возвратов несколько.
    // Обновляем payment по сумме amount_refunded.
    const amountRefunded = charge.amount_refunded ?? 0;
    if (amountRefunded <= 0) return;

    await this.prisma.$transaction(async (tx) => {
      const dbPayment = await tx.payment.findFirst({
        where: { stripeChargeId: charge.id },
        orderBy: { createdAt: 'desc' },
      });
      if (!dbPayment) return;

      const isFullRefund = amountRefunded >= dbPayment.amount;
      await tx.payment.update({
        where: { id: dbPayment.id },
        data: {
          status: isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        },
      });

      this.logger.log(
        `charge.refunded: payment ${dbPayment.id} → ${isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED'}`,
      );
    });
  }

  /**
   * Возврат денег за позднюю оплату терминальной брони.
   */
  private async refundLatePayment(
    bookingId: string,
    paymentIntentId: string | null,
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    if (!paymentIntentId) {
      this.logger.error(
        `Cannot refund late payment for booking ${bookingId}: no payment_intent`,
      );
      return;
    }

    try {
      const refund = await this.stripe.refunds.create({
        payment_intent: paymentIntentId,
        reason: 'requested_by_customer',
        metadata: {
          bookingId,
          reason: 'late_payment_for_terminal_booking',
        },
      });

      await this.prisma.$transaction(async (tx) => {
        const payment = await tx.payment.findFirst({
          where: { bookingId, stripePaymentIntentId: paymentIntentId },
        });

        await tx.refund.create({
          data: {
            bookingId,
            paymentId: payment?.id ?? null,
            stripeRefundId: refund.id,
            amount: refund.amount,
            currency: refund.currency.toUpperCase(),
            status: refund.status === 'succeeded' ? 'PROCESSED' : 'REQUESTED',
            reason: 'late_payment_for_terminal_booking',
            processedAt: refund.status === 'succeeded' ? new Date() : null,
          },
        });

        if (payment) {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status:
                refund.amount >= payment.amount
                  ? 'REFUNDED'
                  : 'PARTIALLY_REFUNDED',
            },
          });
        }

        const booking = await tx.booking.findUnique({
          where: { id: bookingId },
        });
        if (booking) {
          await tx.notification.create({
            data: {
              userId: booking.guestId,
              type: 'REFUND_PROCESSED',
              channel: 'IN_APP',
              title: 'Оплата возвращена',
              body: `Бронь #${booking.code} уже была недействительна. Оплата возвращена.`,
              data: { bookingId },
            },
          });
        }
      });

      this.logger.log(
        `Late payment refunded: bookingId=${bookingId}, refundId=${refund.id}, sessionId=${session.id}`,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown Stripe error';
      this.logger.error(
        `Failed to refund late payment for booking ${bookingId}: ${msg}`,
      );
    }
  }
}
