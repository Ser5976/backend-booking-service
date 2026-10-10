import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';

import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service.js';

@Injectable()
export class BookingsService {
  private readonly stripe: Stripe;

  constructor(private readonly prisma: PrismaService) {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2026-09-30.endive',
    });
  }

  async createCheckoutSession(bookingId: string, userId: string) {
    // 1. Находим бронирование
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { property: true },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    // 2. Проверяем права (только гость может оплатить)
    if (booking.guestId !== userId) {
      throw new ForbiddenException('You can only pay for your own bookings');
    }

    // 3. Проверяем статус
    if (booking.status !== 'PENDING') {
      throw new BadRequestException('Booking is not awaiting payment');
    }

    // 4. Создаем Stripe Checkout Session
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      // payment_method_types: ['card'], ← УДАЛИТЬ ЭТУ СТРОКУ
      line_items: [
        {
          price_data: {
            currency: booking.currency.toLowerCase(),
            product_data: {
              name: `Бронирование: ${booking.property.title}`,
              description: `${booking.checkIn.toISOString().split('T')[0]} — ${booking.checkOut.toISOString().split('T')[0]}`,
            },
            unit_amount: booking.totalAmount,
          },
          quantity: 1,
        },
      ],
      client_reference_id: booking.id,
      customer_email: (booking.guestSnapshot as { email?: string } | null)
        ?.email,
      success_url: `${process.env.FRONTEND_URL}/bookings/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/bookings/cancel`,
      metadata: {
        bookingId: booking.id,
        guestId: userId,
      },
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
    });

    // 5. Сохраняем ID сессии в Payment (создадим запись для отслеживания)
    await this.prisma.payment.create({
      data: {
        bookingId: booking.id,
        userId: userId,
        amount: booking.totalAmount,
        currency: booking.currency,
        status: 'PENDING',
        stripePaymentIntentId: session.payment_intent as string,
        metadata: { checkoutSessionId: session.id },
      },
    });

    return { url: session.url };
  }
}
