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

@Controller('webhooks')
export class StripeWebhookController {
  private readonly logger = new Logger(StripeWebhookController.name);
  private readonly stripe: Stripe;

  constructor(private readonly prisma: PrismaService) {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2026-09-30.endive',
    });
  }

  @Post('stripe')
  @AllowAnonymous()
  @HttpCode(HttpStatus.OK)
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    let event: Stripe.Event;

    // 1. Verify signature — MUST use raw body
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

    // 2. Idempotency: check if already processed
    const existingEvent = await this.prisma.stripeWebhookEvent.findUnique({
      where: { eventId: event.id },
    });

    if (existingEvent?.processed) {
      this.logger.log(`Event ${event.id} already processed, skipping`);
      return { received: true };
    }

    // 3. Store event for idempotency (upsert to handle concurrent deliveries)
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

    // 4. Process based on event type
    try {
      switch (event.type) {
        case 'checkout.session.completed':
          await this.handleCheckoutCompleted(event);
          break;

        case 'checkout.session.async_payment_succeeded':
          await this.handleAsyncPaymentSucceeded(event);
          break;

        case 'checkout.session.expired':
          await this.handleCheckoutExpired(event);
          break;

        case 'payment_intent.payment_failed':
          await this.handlePaymentFailed(event);
          break;

        default:
          this.logger.log(`Unhandled event type: ${event.type}`);
      }

      // 5. Mark as processed
      await this.prisma.stripeWebhookEvent.update({
        where: { eventId: event.id },
        data: { processed: true, processedAt: new Date() },
      });

      this.logger.log(`Successfully processed event: ${event.id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      const stack = err instanceof Error ? err.stack : undefined;

      // Record error for debugging
      await this.prisma.stripeWebhookEvent.update({
        where: { eventId: event.id },
        data: { processed: false, error: message },
      });

      this.logger.error(
        `Failed to process event ${event.id}: ${message}`,
        stack,
      );
      // Re-throw so Stripe sees 5xx and retries
      throw new BadRequestException(`Processing failed: ${message}`);
    }

    return { received: true };
  }

  private async handleCheckoutCompleted(event: Stripe.Event) {
    const session = event.data.object as Stripe.Checkout.Session;
    const bookingId = session.metadata?.bookingId;

    if (!bookingId) {
      this.logger.warn(`checkout.session.completed: no bookingId in metadata`);
      return;
    }

    // Retrieve session with expanded payment_intent to get charge ID
    const expandedSession = await this.stripe.checkout.sessions.retrieve(
      session.id,
      {
        expand: ['payment_intent'],
      },
    );

    const paymentIntent =
      expandedSession.payment_intent as Stripe.PaymentIntent | null;
    const chargeId = paymentIntent?.latest_charge as string | null;
    const paymentIntentId =
      paymentIntent?.id ?? (expandedSession.payment_intent as string | null);

    await this.prisma.$transaction(async (tx) => {
      // Update booking status
      const booking = await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: 'CONFIRMED',
          confirmedAt: new Date(),
        },
      });

      // Update payment record
      await tx.payment.updateMany({
        where: { bookingId },
        data: {
          status: 'SUCCEEDED',
          paidAt: new Date(),
          stripeChargeId: chargeId,
          stripePaymentIntentId: paymentIntentId, // ← ключевое: сохраняем реальный pi_...
          stripeCustomerId: (expandedSession.customer as string) ?? undefined,
          method: paymentIntent?.payment_method_types?.[0] ?? 'card',
        },
      });

      // Create notification for guest
      await tx.notification.create({
        data: {
          userId: booking.guestId,
          type: 'BOOKING_CONFIRMED',
          channel: 'IN_APP',
          title: 'Бронирование подтверждено',
          body: `Ваша оплата прошла успешно. Бронь #${booking.code} подтверждена.`,
          data: { bookingId: booking.id },
        },
      });

      this.logger.log(
        `Booking ${bookingId} confirmed via checkout.session.completed`,
      );
    });
  }

  private async handleAsyncPaymentSucceeded(event: Stripe.Event) {
    const session = event.data.object as Stripe.Checkout.Session;
    const bookingId = session.metadata?.bookingId;

    if (!bookingId) return;

    // Some payment methods (SEPA, Boleto, etc.) succeed asynchronously
    // Treat same as completed
    await this.handleCheckoutCompleted(event);
  }

  private async handleCheckoutExpired(event: Stripe.Event) {
    const session = event.data.object as Stripe.Checkout.Session;
    const bookingId = session.metadata?.bookingId;

    if (!bookingId) return;

    await this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.update({
        where: { id: bookingId, status: 'PENDING' },
        data: {
          status: 'EXPIRED',
        },
      });

      await tx.payment.updateMany({
        where: { bookingId, status: 'PENDING' },
        data: { status: 'FAILED', failureReason: 'Checkout session expired' },
      });

      if (booking) {
        await tx.notification.create({
          data: {
            userId: booking.guestId,
            type: 'PAYMENT_FAILED',
            channel: 'IN_APP',
            title: 'Срок оплаты истек',
            body: `Время на оплату брони #${booking.code} истекло. Бронь отменена.`,
            data: { bookingId: booking.id },
          },
        });
      }

      this.logger.log(`Booking ${bookingId} expired`);
    });
  }

  private async handlePaymentFailed(event: Stripe.Event) {
    const paymentIntent = event.data.object as Stripe.PaymentIntent;
    const bookingId = paymentIntent.metadata?.bookingId;

    if (!bookingId) return;

    await this.prisma.$transaction(async (tx) => {
      await tx.payment.updateMany({
        where: { stripePaymentIntentId: paymentIntent.id },
        data: {
          status: 'FAILED',
          failureReason:
            paymentIntent.last_payment_error?.message ?? 'Payment failed',
        },
      });

      const booking = await tx.booking.findUnique({ where: { id: bookingId } });
      if (booking?.status === 'PENDING') {
        await tx.booking.update({
          where: { id: bookingId },
          data: { status: 'EXPIRED' },
        });
      }

      if (booking) {
        await tx.notification.create({
          data: {
            userId: booking.guestId,
            type: 'PAYMENT_FAILED',
            channel: 'IN_APP',
            title: 'Оплата не прошла',
            body: `Оплата за бронь #${booking.code} не удалась. Попробуйте снова.`,
            data: { bookingId: booking.id },
          },
        });
      }

      this.logger.log(
        `Payment failed for booking ${bookingId}: ${paymentIntent.last_payment_error?.message}`,
      );
    });
  }
}
