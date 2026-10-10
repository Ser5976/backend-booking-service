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
        req.rawBody!, // ← сырое тело запроса
        signature,
        process.env.STRIPE_WEBHOOK_SECRET!,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      throw new BadRequestException(`Webhook Error: ${message}`);
    }

    // Обработка события
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const bookingId = session.metadata?.bookingId;

      if (bookingId) {
        await this.prisma.booking.update({
          where: { id: bookingId },
          data: {
            status: 'CONFIRMED',
            confirmedAt: new Date(),
          },
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

    // Идемпотентность: записываем событие, чтобы не обработать дважды
    await this.prisma.stripeWebhookEvent.upsert({
      where: { eventId: event.id },
      update: { processed: true, processedAt: new Date() },
      create: {
        eventId: event.id,
        type: event.type,
        payload: event as any,
        processed: true,
        processedAt: new Date(),
      },
    });

    return { received: true };
  }
}
