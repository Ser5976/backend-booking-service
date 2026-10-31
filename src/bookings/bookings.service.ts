import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';

import Stripe from 'stripe';
import { PrismaService } from '../prisma/prisma.service.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { CreateBookingDto } from './dto/create-booking.dto.js';
import { Actor } from '../common/auth/actor.js';
import { QueryBookingsDto } from './dto/query-bookings.dto.js';
import { CancelBookingDto } from './dto/cancel-booking.dto.js';

const BOOKING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PAYMENT_TIMEOUT_MINUTES = 15;

@Injectable()
export class BookingsService {
  private readonly stripe: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly pricing: PricingService,
  ) {
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2026-09-30.endive',
    });
  }

  // ============================================================
  // СОЗДАНИЕ БРОНИ
  // ============================================================

  async create(dto: CreateBookingDto, actor: Actor) {
    // 1. Объявление должно существовать, быть опубликовано, не своё
    const property = await this.prisma.property.findUnique({
      where: { id: dto.propertyId },
      include: {
        images: { where: { isCover: true }, take: 1 },
        host: { select: { id: true, name: true, image: true } },
      },
    });
    if (!property || property.deletedAt) {
      throw new NotFoundException('Объявление не найдено');
    }
    if (property.status !== 'PUBLISHED') {
      throw new BadRequestException('Объявление недоступно для бронирования');
    }
    if (property.hostId === actor.id) {
      throw new BadRequestException(
        'Нельзя бронировать собственное объявление',
      );
    }

    // 2. Базовая проверка дат
    if (dto.checkIn >= dto.checkOut) {
      throw new BadRequestException('checkOut должен быть позже checkIn');
    }
    const today = new Date().toISOString().slice(0, 10);
    if (dto.checkIn < today) {
      throw new BadRequestException('Нельзя бронировать прошедшие даты');
    }

    // 3. Быстрая проверка занятости (до транзакции)
    const unavailable = await this.availability.findUnavailableDatesInRange(
      dto.propertyId,
      dto.checkIn,
      dto.checkOut,
    );
    if (unavailable.size > 0) {
      throw new ConflictException(
        `Даты недоступны: ${[...unavailable].sort().join(', ')}`,
      );
    }

    // 4. Расчёт цены
    const price = await this.pricing.calculatePrice({
      propertyId: dto.propertyId,
      checkIn: dto.checkIn,
      checkOut: dto.checkOut,
      guests: dto.guests,
    });

    // 5. Данные гостя для снапшота и Stripe customer_email
    const guest = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { id: true, email: true, name: true },
    });
    if (!guest) {
      throw new NotFoundException('Пользователь не найден');
    }

    // 6. Снапшоты
    const propertySnapshot = {
      id: property.id,
      title: property.title,
      slug: property.slug,
      type: property.type,
      city: property.city,
      country: property.country,
      coverImage: property.images[0]?.url ?? null,
      checkInTime: property.checkInTime,
      checkOutTime: property.checkOutTime,
      host: property.host,
    };
    const guestSnapshot = {
      id: guest.id,
      email: guest.email,
      name: guest.name,
    };

    // 7. Транзакция: advisory lock → recheck → create → notify
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dto.propertyId}))`;

          const recheck = await tx.booking.findMany({
            where: {
              propertyId: dto.propertyId,
              status: { in: ['PENDING', 'CONFIRMED'] },
              checkIn: { lt: new Date(`${dto.checkOut}T00:00:00.000Z`) },
              checkOut: { gt: new Date(`${dto.checkIn}T00:00:00.000Z`) },
            },
            select: { id: true },
          });
          if (recheck.length > 0) {
            throw new ConflictException(
              'Даты только что были заняты. Попробуйте другие.',
            );
          }

          const booking = await tx.booking.create({
            data: {
              code: this.generateBookingCode(),
              propertyId: dto.propertyId,
              guestId: actor.id,
              hostId: property.hostId,
              checkIn: new Date(`${dto.checkIn}T00:00:00.000Z`),
              checkOut: new Date(`${dto.checkOut}T00:00:00.000Z`),
              nights: price.nights,
              guests: dto.guests,
              adults: dto.guests,
              children: dto.children ?? 0,
              infants: dto.infants ?? 0,
              status: 'PENDING',
              currency: property.currency,
              pricePerNight: price.pricePerNight,
              nightsTotal: price.nightsTotal,
              cleaningFee: price.cleaningFee,
              serviceFee: price.serviceFee,
              taxes: price.taxes,
              discount: price.discount,
              totalAmount: price.totalAmount,
              hostPayoutAmount: price.hostPayoutAmount,
              propertySnapshot,
              guestSnapshot,
              guestMessage: dto.guestMessage,
              expiresAt: new Date(
                Date.now() + PAYMENT_TIMEOUT_MINUTES * 60 * 1000,
              ),
            },
          });

          await tx.notification.create({
            data: {
              userId: property.hostId,
              type: 'BOOKING_CREATED',
              channel: 'IN_APP',
              title: 'Новая бронь',
              body: `Гость забронировал "${property.title}" на ${price.nights} ноч. Ожидает оплаты.`,
              data: { bookingId: booking.id },
            },
          });

          return booking;
        });
      } catch (e: any) {
        // Коллизия по code — повторяем
        if (e?.code === 'P2002' && attempt < 2) continue;
        throw e;
      }
    }

    throw new BadRequestException(
      'Не удалось создать бронь, попробуйте ещё раз',
    );
  }

  // ============================================================
  // STRIPE CHECKOUT
  // ============================================================

  async createCheckoutSession(bookingId: string, userId: string) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { property: true },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.guestId !== userId) {
      throw new ForbiddenException('You can only pay for your own bookings');
    }

    if (booking.status !== 'PENDING') {
      throw new BadRequestException('Booking is not awaiting payment');
    }

    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
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

  // ============================================================
  // VERIFY PAYMENT (fallback для webhook)
  // ============================================================

  async verifyPaymentBySession(
    sessionId: string,
    userId: string,
  ): Promise<{
    status: string;
    booking?: any;
    paymentStatus?: string;
    message?: string;
  }> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent'],
    });

    const bookingId = session.metadata?.bookingId;
    if (!bookingId) {
      throw new BadRequestException('Invalid session: no bookingId');
    }

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    if (!booking || booking.guestId !== userId) {
      throw new ForbiddenException('Not your booking');
    }

    if (booking.status === 'CONFIRMED') {
      return { status: 'already_confirmed', booking };
    }

    const paymentIntent = session.payment_intent as Stripe.PaymentIntent | null;
    const paymentStatus = paymentIntent?.status ?? session.payment_status;

    if (paymentStatus === 'paid' || session.payment_status === 'paid') {
      await this.prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: 'CONFIRMED',
            confirmedAt: new Date(),
          },
        });

        const chargeId = paymentIntent?.latest_charge as string | null;
        await tx.payment.updateMany({
          where: { bookingId },
          data: {
            status: 'SUCCEEDED',
            paidAt: new Date(),
            stripeChargeId: chargeId ?? (session.payment_intent as string),
            stripeCustomerId: (session.customer as string) ?? undefined,
            method: paymentIntent?.payment_method_types?.[0] ?? 'card',
          },
        });

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
      });

      return { status: 'confirmed', booking };
    }

    return {
      status: 'pending',
      paymentStatus,
      message: 'Payment not completed yet',
    };
  }

  // ============================================================
  // ХЕЛПЕРЫ
  // ============================================================

  /**
   * Человекочитаемый код брони: BK-2025-A3F9K2.
   * Без похожих символов (0/O, 1/I/L), чтобы не путать при чтении вслух.
   * Уникальность гарантируется @unique в БД + ретрай в create().
   */
  private generateBookingCode(): string {
    const year = new Date().getUTCFullYear();
    let suffix = '';
    for (let i = 0; i < 6; i++) {
      suffix +=
        BOOKING_CODE_ALPHABET[
          Math.floor(Math.random() * BOOKING_CODE_ALPHABET.length)
        ];
    }
    return `BK-${year}-${suffix}`;
  }

  // ============================================================
  // СПИСОК БРОНЕЙ
  // ============================================================

  /**
   * Список броней текущего пользователя.
   * role=guest — где он гость; role=host — где он хост.
   * Сортировка: ближайшие checkIn сверху; прошедшие — в конце.
   */
  async findMy(actor: Actor, query: QueryBookingsDto) {
    const role = query.role ?? 'guest';
    const where: any = {
      status: query.status ? query.status : undefined,
    };

    if (role === 'guest') {
      where.guestId = actor.id;
    } else {
      where.hostId = actor.id;
    }

    // Убираем undefined, чтобы Prisma не ругался
    if (where.status === undefined) delete where.status;

    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.booking.findMany({
        where,
        orderBy: [{ checkIn: 'asc' }, { createdAt: 'desc' }],
        skip: offset,
        take: limit,
        include: {
          property: {
            select: {
              id: true,
              title: true,
              slug: true,
              city: true,
              country: true,
              images: { where: { isCover: true }, take: 1 },
            },
          },
          review: { select: { id: true, ratingOverall: true } },
        },
      }),
      this.prisma.booking.count({ where }),
    ]);

    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }

  // ============================================================
  // ДЕТАЛИ БРОНИ
  // ============================================================

  /**
   * Детали одной брони. Доступ: гость, хост, админ.
   * Включает property, payments, review.
   */
  async findOne(bookingId: string, actor: Actor) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        property: {
          select: {
            id: true,
            title: true,
            slug: true,
            city: true,
            country: true,
            street: true,
            building: true,
            apartment: true,
            checkInTime: true,
            checkOutTime: true,
            images: { orderBy: { order: 'asc' }, take: 5 },
          },
        },
        payments: {
          select: {
            id: true,
            status: true,
            amount: true,
            currency: true,
            method: true,
            paidAt: true,
            failureReason: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        review: {
          select: {
            id: true,
            ratingOverall: true,
            comment: true,
            createdAt: true,
          },
        },
      },
    });

    if (!booking) {
      throw new NotFoundException('Бронь не найдена');
    }

    const isGuest = booking.guestId === actor.id;
    const isHost = booking.hostId === actor.id;
    const isAdmin = actor.role === 'ADMIN';

    if (!isGuest && !isHost && !isAdmin) {
      // 404, а не 403 — не палим существование чужой брони
      throw new NotFoundException('Бронь не найдена');
    }

    return booking;
  }
  // src/bookings/bookings.service.ts (добавить)

  /**
   * Отмена брони с возвратом через Stripe.
   * - PENDING: без возврата.
   * - CONFIRMED: возврат по правилам (полный/50%/100% при отмене хостом).
   * - Прочие статусы: 400.
   */
  async cancel(bookingId: string, dto: CancelBookingDto, actor: Actor) {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: {
        payments: {
          where: { status: 'SUCCEEDED', stripePaymentIntentId: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    if (!booking) throw new NotFoundException('Бронь не найдена');

    const isGuest = booking.guestId === actor.id;
    const isHost = booking.hostId === actor.id;
    const isAdmin = actor.role === 'ADMIN';
    if (!isGuest && !isHost && !isAdmin) {
      throw new NotFoundException('Бронь не найдена');
    }

    // Какие статусы можно отменить
    const cancellable = ['PENDING', 'CONFIRMED'];
    if (!cancellable.includes(booking.status)) {
      throw new BadRequestException(
        `Нельзя отменить бронь в статусе ${booking.status}`,
      );
    }

    // Определяем, кто отменяет
    const cancelledBy: 'CANCELLED_BY_GUEST' | 'CANCELLED_BY_HOST' = isHost
      ? 'CANCELLED_BY_HOST'
      : 'CANCELLED_BY_GUEST';

    // PENDING — без возврата
    if (booking.status === 'PENDING') {
      return this.prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: cancelledBy,
          cancelledAt: new Date(),
          cancellationReason: dto.reason ?? null,
        },
      });
    }

    // CONFIRMED — считаем сумму возврата
    const refundAmount = this.calculateRefundAmount(booking, isHost || isAdmin);

    // Ищем успешный платёж для Stripe Refund
    const payment = booking.payments[0];
    if (!payment || !payment.stripePaymentIntentId) {
      // Платёж не найден — отменяем без Stripe Refund
      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: cancelledBy,
            cancelledAt: new Date(),
            cancellationReason: dto.reason ?? null,
          },
        });

        await tx.refund.create({
          data: {
            bookingId: booking.id,
            paymentId: null,
            amount: refundAmount,
            currency: booking.currency,
            status: 'REJECTED',
            reason: dto.reason ?? 'No succeeded payment to refund',
            adminNote:
              'PaymentIntent not found — refund cannot be processed via Stripe',
          },
        });

        await tx.notification.create({
          data: {
            userId: booking.guestId,
            type: 'REFUND_PROCESSED',
            channel: 'IN_APP',
            title: 'Бронь отменена',
            body: `Бронь #${booking.code} отменена. Возврат не может быть обработан автоматически, свяжитесь с поддержкой.`,
            data: { bookingId: booking.id },
          },
        });

        return updated;
      });
    }

    // Создаём Stripe Refund
    let stripeRefund: Stripe.Refund | null = null;
    let stripeError: string | null = null;
    try {
      stripeRefund = await this.stripe.refunds.create({
        payment_intent: payment.stripePaymentIntentId,
        amount: refundAmount,
        reason: 'requested_by_customer',
        metadata: {
          bookingId: booking.id,
          cancelledBy,
        },
      });
    } catch (e: any) {
      stripeError = e?.message ?? 'Unknown Stripe error';
    }

    // Обновляем БД в транзакции
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: cancelledBy,
          cancelledAt: new Date(),
          cancellationReason: dto.reason ?? null,
        },
      });

      // Refund

      const refundStatus = stripeError
        ? 'REJECTED'
        : stripeRefund?.status === 'succeeded'
          ? 'PROCESSED'
          : 'REQUESTED'; // pending или requires_action

      const refundRecord = await tx.refund.create({
        data: {
          bookingId: booking.id,
          paymentId: payment.id,
          stripeRefundId: stripeRefund?.id ?? null,
          amount: refundAmount,
          currency: booking.currency,
          status: refundStatus,
          reason: dto.reason ?? null,
          adminNote: stripeError,
          processedAt: refundStatus === 'PROCESSED' ? new Date() : null,
        },
      });

      // Payment
      if (!stripeError) {
        const isFullRefund = refundAmount >= booking.totalAmount;
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          },
        });
      }

      // Уведомление гостю
      await tx.notification.create({
        data: {
          userId: booking.guestId,
          type: 'REFUND_PROCESSED',
          channel: 'IN_APP',
          title: stripeError
            ? 'Бронь отменена, возврат не прошёл'
            : 'Бронь отменена',
          body: stripeError
            ? `Бронь #${booking.code} отменена. Возврат не удался: ${stripeError}. Свяжитесь с поддержкой.`
            : `Бронь #${booking.code} отменена. Возврат ${refundAmount / 100} ${booking.currency} обработан.`,
          data: { bookingId: booking.id, refundId: refundRecord.id },
        },
      });

      // Уведомление хосту (если отменил гость)
      if (cancelledBy === 'CANCELLED_BY_GUEST') {
        await tx.notification.create({
          data: {
            userId: booking.hostId,
            type: 'BOOKING_CANCELLED',
            channel: 'IN_APP',
            title: 'Гость отменил бронь',
            body: `Бронь #${booking.code} отменена гостем.`,
            data: { bookingId: booking.id },
          },
        });
      }

      return updated;
    });
  }

  /**
   * Сумма возврата:
   * - Хост/админ отменяет → 100% totalAmount.
   * - Гость, checkIn - today >= 3 дня → 100%.
   * - Гость, меньше 3 дней → 50% (округление вниз).
   */
  private calculateRefundAmount(
    booking: { totalAmount: number; checkIn: Date },
    isHostOrAdmin: boolean,
  ): number {
    if (isHostOrAdmin) return booking.totalAmount;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const checkIn = new Date(booking.checkIn);
    checkIn.setUTCHours(0, 0, 0, 0);

    const daysUntilCheckIn = Math.round(
      (checkIn.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (daysUntilCheckIn >= 3) return booking.totalAmount;
    return Math.floor(booking.totalAmount * 0.5);
  }
}
