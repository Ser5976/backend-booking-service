import {
  Controller,
  Post,
  Req,
  Headers,
  BadRequestException,
} from '@nestjs/common';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { RawBodyRequest } from '@nestjs/common'; // ← import type
import type { Request } from 'express'; // ← тоже тип
import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('webhooks')
export class StripeWebhookController {
  private stripe: Stripe;

  constructor(private prisma: PrismaService) {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2026-09-30.endive',
    });
  }

  @Post('stripe')
  @AllowAnonymous()
  async handleStripeWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    let event: Stripe.Event;

    try {
      event = this.stripe.webhooks.constructEvent(
        req.rawBody!,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new BadRequestException(`Webhook Error: ${message}`);
    }

    // 1. СНАЧАЛА отвечаем Stripe, что событие принято
    // (не дожидаясь записи в БД)

    // 2. ПОТОМ асинхронно обрабатываем (не блокируя ответ)
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const bookingId = session.metadata?.bookingId;

      if (bookingId) {
        // Запускаем обработку, но не ждем её завершения
        this.processBookingConfirmation(bookingId, session).catch((err) => {
          console.error('Failed to process booking confirmation:', err);
        });
      }
    }

    // 3. Явно возвращаем 200, чтобы Stripe получил ответ
    return { received: true };
  }

  private async processBookingConfirmation(
    bookingId: string,
    session: Stripe.Checkout.Session,
  ) {
    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { status: 'CONFIRMED', confirmedAt: new Date() },
    });

    await this.prisma.payment.updateMany({
      where: { bookingId },
      data: {
        status: 'SUCCEEDED',
        paidAt: new Date(),
        stripeChargeId: session.payment_intent as string,
      },
    });
  }
}
