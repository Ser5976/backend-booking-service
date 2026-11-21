import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';

import Stripe from 'stripe';
import { Prisma, UserRole } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StripeService } from '../stripe/stripe.service.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { CreateBookingDto } from './dto/create-booking.dto.js';
import { Actor } from '../common/auth/actor.js';
import { QueryBookingsDto } from './dto/query-bookings.dto.js';
import { CancelBookingDto } from './dto/cancel-booking.dto.js';

// Алфавит для генерации кода брони.
// Исключены похожие символы (0/O, 1/I/L), чтобы код было легко читать вслух.
const BOOKING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Сколько минут даётся гостю на оплату брони после её создания.
const PAYMENT_TIMEOUT_MINUTES = 30;

// Сколько попыток делаем при коллизии уникального кода брони (P2002).
const BOOKING_CODE_RETRY_ATTEMPTS = 3;

// Сколько дней до заезда даёт право на полный возврат (иначе — 50%).
const FULL_REFUND_DAYS_BEFORE_CHECKIN = 3;

// Терминальные статусы — оплата по ним не должна подтверждать бронь.
const TERMINAL_STATUSES: readonly string[] = [
  'EXPIRED',
  'CANCELLED_BY_GUEST',
  'CANCELLED_BY_HOST',
];

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  // Stripe-клиент инжектится из StripeService — единый экземпляр на приложение.
  private readonly stripe: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripeService: StripeService,
    private readonly availability: AvailabilityService,
    private readonly pricing: PricingService,
  ) {
    this.stripe = this.stripeService.client;
  }

  // ============================================================
  // 1. СОЗДАНИЕ БРОНИ
  // ============================================================

  async create(dto: CreateBookingDto, actor: Actor) {
    // 1.1. Проверяем, что объявление существует и не удалено.
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

    // 1.2. Базовая проверка дат.
    if (dto.checkIn >= dto.checkOut) {
      throw new BadRequestException('checkOut должен быть позже checkIn');
    }
    const today = new Date().toISOString().slice(0, 10);
    if (dto.checkIn < today) {
      throw new BadRequestException('Нельзя бронировать прошедшие даты');
    }

    // 1.3. Проверка вместимости (minNights/maxNights валидирует PricingService).
    if (property.maxGuests && dto.guests > property.maxGuests) {
      throw new BadRequestException(
        `Максимум гостей для этого объявления — ${property.maxGuests}`,
      );
    }

    // 1.4. Предварительная проверка занятости дат (вне транзакции).
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

    // 1.5. Расчёт цены (PricingService валидирует minNights/maxNights).
    const price = await this.pricing.calculatePrice({
      propertyId: dto.propertyId,
      checkIn: dto.checkIn,
      checkOut: dto.checkOut,
      guests: dto.guests,
    });

    // 1.6. Данные гостя для снапшота и customer_email.
    const guest = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { id: true, email: true, name: true },
    });
    if (!guest) {
      throw new NotFoundException('Пользователь не найден');
    }

    // 1.7. Снапшоты — фиксируем состояние на момент бронирования.
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

    // 1.8. Транзакция с advisory lock и ретраем по P2002.
    // pg_advisory_xact_lock(hashtext(propertyId)) гарантирует,
    // что два параллельных create() на одно объявление выполняются последовательно.
    // Первый создаёт бронь, второй видит её в recheck и падает с 409.
    // Без лока была бы гонка: оба прошли бы recheck, оба создали бы бронь — и получили бы пересечение.
    for (let attempt = 0; attempt < BOOKING_CODE_RETRY_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dto.propertyId}))`;
          const now = new Date();

          // Повторная проверка пересечения дат внутри транзакции.
          const recheck = await tx.booking.findMany({
            where: {
              propertyId: dto.propertyId,
              OR: [
                { status: 'CONFIRMED' },
                { status: 'PENDING', expiresAt: { gt: now } },
              ],
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
              channel: 'EMAIL',
              title: 'Новая бронь',
              body: `Гость забронировал "${property.title}" на ${price.nights} ноч. Ожидает оплаты.`,
              data: { bookingId: booking.id },
            },
          });

          this.logger.log(
            `Booking created: id=${booking.id}, code=${booking.code}, total=${booking.totalAmount} ${booking.currency}`,
          );

          return booking;
        });
      } catch (e: unknown) {
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === 'P2002' &&
          attempt < BOOKING_CODE_RETRY_ATTEMPTS - 1
        ) {
          this.logger.warn(
            `Booking code collision, retry ${attempt + 1}/${BOOKING_CODE_RETRY_ATTEMPTS}`,
          );
          continue;
        }
        throw e;
      }
    }

    throw new BadRequestException(
      'Не удалось создать бронь, попробуйте ещё раз',
    );
  }

  // ============================================================
  // 2. ОПЛАТА ЧЕРЕЗ STRIPE (CHECKOUT SESSION)
  // ============================================================

  async createCheckoutSession(bookingId: string, userId: string) {
    // 2.1. Загружаем бронь вместе с объявлением.
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

    // 2.2. Ленивая проверка истечения (крон может ещё не успеть).
    if (booking.expiresAt && booking.expiresAt < new Date()) {
      await this.prisma.booking.update({
        where: { id: booking.id },
        data: { status: 'EXPIRED' },
      });
      this.logger.warn(`Booking ${booking.id} expired before payment`);
      throw new BadRequestException('Срок оплаты брони истёк');
    }

    // 2.3. Сумма 0 (полная скидка) — Stripe не примет unit_amount=0.
    if (booking.totalAmount <= 0) {
      await this.prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: booking.id },
          data: { status: 'CONFIRMED', confirmedAt: new Date() },
        });
        await tx.notification.create({
          data: {
            userId: booking.guestId,
            type: 'BOOKING_CONFIRMED',
            channel: 'IN_APP',
            title: 'Бронирование подтверждено',
            body: `Бронь #${booking.code} подтверждена (бесплатное бронирование).`,
            data: { bookingId: booking.id },
          },
        });
      });
      this.logger.log(
        `Booking ${booking.id} confirmed without payment (totalAmount=0)`,
      );
      return { url: null, confirmed: true };
    }

    // 2.4. Создаём Stripe Checkout Session.
    //      payment_intent_data.metadata — чтобы bookingId был доступен
    //      в событии payment_intent.payment_failed (не только в session.metadata).
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
      customer_email: this.extractGuestEmail(booking.guestSnapshot),
      success_url: `${process.env.FRONTEND_URL}/bookings/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL}/bookings/cancel`,
      metadata: { bookingId: booking.id, guestId: userId },
      payment_intent_data: {
        metadata: { bookingId: booking.id, guestId: userId },
      },
      expires_at: Math.floor(Date.now() / 1000) + PAYMENT_TIMEOUT_MINUTES * 60,
    });

    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (session.payment_intent?.id ?? null);

    // 2.5. Переиспользуем существующий PENDING payment, если он есть.
    //      Иначе при двойном клике создадутся два платежа с null → @unique
    //      на stripePaymentIntentId при последующем webhook.
    const existingPending = await this.prisma.payment.findFirst({
      where: { bookingId: booking.id, status: 'PENDING' },
      orderBy: { createdAt: 'desc' },
    });

    if (existingPending) {
      await this.prisma.payment.update({
        where: { id: existingPending.id },
        data: {
          stripePaymentIntentId: paymentIntentId,
          metadata: { checkoutSessionId: session.id },
        },
      });
    } else {
      await this.prisma.payment.create({
        data: {
          bookingId: booking.id,
          userId,
          amount: booking.totalAmount,
          currency: booking.currency,
          status: 'PENDING',
          stripePaymentIntentId: paymentIntentId,
          metadata: { checkoutSessionId: session.id },
        },
      });
    }

    this.logger.log(
      `Checkout session created: bookingId=${booking.id}, sessionId=${session.id}, pi=${paymentIntentId ?? 'null'}`,
    );

    return { url: session.url, confirmed: false };
  }

  // ============================================================
  // 3. ПРОВЕРКА ОПЛАТЫ (FALLBACK ДЛЯ WEBHOOK)
  // ============================================================

  async verifyPaymentBySession(
    sessionId: string,
    userId: string,
  ): Promise<{
    status: string;
    booking?: unknown;
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

    // Оплата пришла, но бронь уже терминальная — возвращаем деньги.
    if (TERMINAL_STATUSES.includes(booking.status)) {
      this.logger.warn(
        `Payment for terminal booking ${booking.id} (status=${booking.status}) — refunding`,
      );
      await this.refundLatePayment(booking.id, session);
      throw new BadRequestException(
        'Бронь уже недействительна. Оплата будет возвращена.',
      );
    }

    const paymentIntent = session.payment_intent as Stripe.PaymentIntent | null;
    const paymentStatus = paymentIntent?.status ?? session.payment_status;

    if (paymentStatus === 'paid' || session.payment_status === 'paid') {
      await this.confirmPaidBooking(booking.id, booking, session);
      this.logger.log(
        `Booking ${booking.id} confirmed via verifyPaymentBySession`,
      );
      return { status: 'confirmed', booking };
    }

    return {
      status: 'pending',
      paymentStatus,
      message: 'Payment not completed yet',
    };
  }

  // ============================================================
  // 4. СПИСОК БРОНЕЙ
  // ============================================================

  /**
   * Список броней текущего пользователя.
   * Будущие — сверху (по возрастанию checkIn), прошедшие — в конце (по убыванию).
   */
  async findMy(actor: Actor, query: QueryBookingsDto) {
    const role = query.role ?? 'guest';
    const where: Prisma.BookingWhereInput = {};

    if (role === 'guest') {
      where.guestId = actor.id;
    } else {
      where.hostId = actor.id;
    }
    if (query.status) {
      where.status = query.status;
    }

    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    // Разделяем на будущие и прошедшие, чтобы отсортировать «ближайшие сверху».
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const upcomingWhere: Prisma.BookingWhereInput = {
      ...where,
      checkOut: { gte: today },
    };
    const pastWhere: Prisma.BookingWhereInput = {
      ...where,
      checkOut: { lt: today },
    };

    // 4.5. Сначала считаем totals — без циклической зависимости.
    const [upcomingTotal, pastTotal] = await this.prisma.$transaction([
      this.prisma.booking.count({ where: upcomingWhere }),
      this.prisma.booking.count({ where: pastWhere }),
    ]);

    // 4.6. Сколько элементов нужно взять из каждой части.
    //      Сначала заполняем upcoming (с учётом offset), остаток — из past.
    const upcomingTake = Math.max(0, Math.min(limit, upcomingTotal - offset));
    const pastOffset = Math.max(0, offset - upcomingTotal);
    const pastTake = Math.max(0, limit - upcomingTake);

    // 4.7. Забираем страницу.
    const [upcomingItems, pastItems] = await this.prisma.$transaction([
      this.prisma.booking.findMany({
        where: upcomingWhere,
        orderBy: [{ checkIn: 'asc' }, { createdAt: 'desc' }],
        skip: offset,
        take: upcomingTake,
        include: this.bookingListInclude(),
      }),
      pastTake > 0
        ? this.prisma.booking.findMany({
            where: pastWhere,
            orderBy: [{ checkIn: 'desc' }, { createdAt: 'desc' }],
            skip: pastOffset,
            take: pastTake,
            include: this.bookingListInclude(),
          })
        : this.prisma.booking.findMany({
            where: { id: '__never__' },
            take: 0,
            include: this.bookingListInclude(),
          }),
    ]);

    // 4.8. Склеиваем: сначала будущие, потом прошедшие.
    const items = [...upcomingItems, ...pastItems];
    const total = upcomingTotal + pastTotal;

    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }

  // ============================================================
  // 5. ДЕТАЛИ БРОНИ
  // ============================================================

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

    this.assertCanAccess(booking, actor);

    // Пока бронь PENDING — скрываем точный адрес от гостя.
    const isGuest = booking.guestId === actor.id;
    const isAdmin = actor.role === UserRole.ADMIN;
    if (isGuest && !isAdmin && booking.status === 'PENDING') {
      return {
        ...booking,
        property: booking.property
          ? {
              ...booking.property,
              street: null,
              building: null,
              apartment: null,
            }
          : null,
      };
    }

    return booking;
  }

  // ============================================================
  // 6. ОТМЕНА БРОНИ И ВОЗВРАТ СРЕДСТВ
  // ============================================================

  /**
   * Отмена брони с возвратом через Stripe.
   * - PENDING: без возврата (или EXPIRED, если срок уже истёк).
   * - CONFIRMED: возврат по правилам.
   * - После checkIn отмена запрещена.
   * - Админ отменяет как гость (статус CANCELLED_BY_GUEST) + AuditLog.
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

    this.assertCanAccess(booking, actor);

    const isGuest = booking.guestId === actor.id;
    const isHost = booking.hostId === actor.id;
    const isAdmin = actor.role === UserRole.ADMIN;

    // Отменить можно только PENDING или CONFIRMED.
    if (!['PENDING', 'CONFIRMED'].includes(booking.status)) {
      throw new BadRequestException(
        `Нельзя отменить бронь в статусе ${booking.status}`,
      );
    }

    // После заезда отмена запрещена.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    if (booking.checkIn < today) {
      throw new BadRequestException('Нельзя отменить бронь после даты заезда');
    }

    // Админ отменяет как гость (без отдельного статуса).
    const cancelledBy: 'CANCELLED_BY_GUEST' | 'CANCELLED_BY_HOST' =
      isHost && !isGuest && !isAdmin
        ? 'CANCELLED_BY_HOST'
        : 'CANCELLED_BY_GUEST';

    // 6.1. PENDING — оплаты ещё не было.
    if (booking.status === 'PENDING') {
      const isExpired = booking.expiresAt && booking.expiresAt < new Date();
      const newStatus = isExpired ? 'EXPIRED' : cancelledBy;

      const updated = await this.prisma.booking.update({
        where: { id: bookingId },
        data: {
          status: newStatus,
          cancelledAt: isExpired ? null : new Date(),
          cancellationReason: isExpired ? null : (dto.reason ?? null),
        },
      });

      if (isAdmin) {
        await this.prisma.auditLog.create({
          data: {
            actorId: actor.id,
            action: 'booking.cancel',
            entityType: 'Booking',
            entityId: booking.id,
            before: { status: booking.status },
            after: { status: newStatus },
          },
        });
      }

      this.logger.log(
        `Booking ${booking.id} (PENDING) cancelled as ${newStatus} by ${cancelledBy}${isAdmin ? ' (admin)' : ''}`,
      );

      return updated;
    }

    // 6.2. CONFIRMED — считаем возврат.
    const refundAmount = this.calculateRefundAmount(booking, isHost);

    const payment = booking.payments[0];

    // 6.3. Нет платежа / нет PaymentIntent / сумма возврата <= 0 —
    //      отменяем без Stripe Refund.
    if (!payment || !payment.stripePaymentIntentId || refundAmount <= 0) {
      const reasonText = !payment
        ? 'No succeeded payment to refund'
        : !payment.stripePaymentIntentId
          ? 'PaymentIntent missing'
          : 'Refund amount is zero';

      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: cancelledBy,
            cancelledAt: new Date(),
            cancellationReason: dto.reason ?? null,
          },
        });

        if (refundAmount > 0) {
          await tx.refund.create({
            data: {
              bookingId: booking.id,
              paymentId: payment?.id ?? null,
              amount: refundAmount,
              currency: booking.currency,
              status: 'REJECTED',
              reason: dto.reason ?? reasonText,
              adminNote: reasonText,
            },
          });
        }

        await tx.notification.create({
          data: {
            userId: booking.guestId,
            type: 'REFUND_PROCESSED',
            channel: 'EMAIL',
            title: 'Бронь отменена',
            body:
              refundAmount > 0
                ? `Бронь #${booking.code} отменена. Возврат не может быть обработан автоматически (${reasonText}), свяжитесь с поддержкой.`
                : `Бронь #${booking.code} отменена.`,
            data: { bookingId: booking.id },
          },
        });

        if (isAdmin) {
          await tx.auditLog.create({
            data: {
              actorId: actor.id,
              action: 'booking.cancel',
              entityType: 'Booking',
              entityId: booking.id,
              before: { status: booking.status },
              after: { status: cancelledBy },
            },
          });
        }

        this.logger.warn(
          `Booking ${booking.id} cancelled without Stripe refund: ${reasonText}`,
        );

        return updated;
      });
    }

    // 6.4. Пытаемся создать возврат в Stripe.
    let stripeRefund: Stripe.Refund | null = null;
    let stripeError: string | null = null;
    try {
      stripeRefund = await this.stripe.refunds.create({
        payment_intent: payment.stripePaymentIntentId,
        amount: refundAmount,
        reason: 'requested_by_customer',
        metadata: { bookingId: booking.id, cancelledBy },
      });
    } catch (e: unknown) {
      stripeError = e instanceof Error ? e.message : 'Unknown Stripe error';
      this.logger.error(
        `Stripe refund failed for booking ${booking.id}: ${stripeError}`,
      );
    }

    // 6.5. Обновляем БД в одной транзакции.
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: cancelledBy,
          cancelledAt: new Date(),
          cancellationReason: dto.reason ?? null,
        },
      });

      const refundStatus = stripeError
        ? 'REJECTED'
        : stripeRefund?.status === 'succeeded'
          ? 'PROCESSED'
          : 'REQUESTED'; // pending/requires_action → обновит webhook refund.updated

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

      if (!stripeError) {
        const isFullRefund = refundAmount >= booking.totalAmount;
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          },
        });
      }

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
            : `Бронь #${booking.code} отменена. Возврат ${this.formatAmount(refundAmount, booking.currency)} обработан.`,
          data: { bookingId: booking.id, refundId: refundRecord.id },
        },
      });

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

      if (isAdmin) {
        await tx.auditLog.create({
          data: {
            actorId: actor.id,
            action: 'booking.cancel',
            entityType: 'Booking',
            entityId: booking.id,
            before: { status: booking.status },
            after: { status: cancelledBy },
          },
        });
      }

      this.logger.log(
        `Booking ${booking.id} cancelled as ${cancelledBy}${isAdmin ? ' (admin)' : ''}, refund=${refundAmount} ${booking.currency}, status=${refundStatus}`,
      );

      return updated;
    });
  }

  // ============================================================
  // 7. ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
  // ============================================================

  private assertCanAccess(
    booking: { guestId: string; hostId: string },
    actor: Actor,
  ): void {
    const allowed =
      booking.guestId === actor.id ||
      booking.hostId === actor.id ||
      actor.role === UserRole.ADMIN;
    if (!allowed) {
      throw new NotFoundException('Бронь не найдена');
    }
  }

  private bookingListInclude(): Prisma.BookingInclude {
    return {
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
    };
  }

  private extractGuestEmail(
    snapshot: Prisma.JsonValue | null,
  ): string | undefined {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return undefined;
    }
    const email = (snapshot as { email?: unknown }).email;
    return typeof email === 'string' ? email : undefined;
  }

  private formatAmount(amount: number, currency: string): string {
    try {
      return new Intl.NumberFormat('ru-RU', {
        style: 'currency',
        currency,
      }).format(amount / 100);
    } catch {
      return `${amount / 100} ${currency}`;
    }
  }

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

  /**
   * Подтверждает оплаченную бронь: обновляет booking + payment,
   * создаёт платёж, если его не было, и уведомляет гостя.
   * Обновление payment идёт по checkoutSessionId из metadata,
   * чтобы не задеть чужой платёж при двух сессиях.
   */
  private async confirmPaidBooking(
    bookingId: string,
    booking: {
      id: string;
      guestId: string;
      code: string;
      totalAmount: number;
      currency: string;
    },
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const paymentIntent = session.payment_intent as Stripe.PaymentIntent | null;
    const chargeId = (paymentIntent?.latest_charge as string | null) ?? null;
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : (paymentIntent?.id ?? null);

    await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      });

      // Обновляем платёж, привязанный именно к этой checkout-сессии.
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
          stripeCustomerId: (session.customer as string) ?? undefined,
          method: paymentIntent?.payment_method_types?.[0] ?? 'card',
        },
      });

      // Если платежа не было (createCheckoutSession упал после Stripe) — создаём.
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
            stripeCustomerId: (session.customer as string) ?? undefined,
            method: paymentIntent?.payment_method_types?.[0] ?? 'card',
            metadata: { checkoutSessionId: session.id, recovered: true },
          },
        });
      }

      await tx.notification.create({
        data: {
          userId: booking.guestId,
          type: 'BOOKING_CONFIRMED',
          channel: 'IN_APP',
          title: 'Бронирование подтверждено',
          body: `Ваша оплата прошла успешно. Бронь #${booking.code} подтверждена.`,
          data: { bookingId },
        },
      });
    });
  }

  /**
   * Возврат денег за позднюю оплату терминальной брони.
   */
  private async refundLatePayment(
    bookingId: string,
    session: Stripe.Checkout.Session,
  ): Promise<void> {
    const paymentIntentId =
      typeof session.payment_intent === 'string'
        ? session.payment_intent
        : ((session.payment_intent as Stripe.PaymentIntent | null)?.id ?? null);

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
        `Late payment refunded: bookingId=${bookingId}, refundId=${refund.id}`,
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Unknown Stripe error';
      this.logger.error(
        `Failed to refund late payment for booking ${bookingId}: ${msg}`,
      );
    }
  }

  // ============================================================
  // 8. РАСЧЁТ ВОЗВРАТА
  // ============================================================

  /**
   * Сумма возврата:
   * - Хост отменяет → 100% totalAmount.
   * - Гость, checkIn - today >= 3 дня → 100%.
   * - Гость, меньше 3 дней → 50% (округление вниз).
   * - Админ отменяет как гость (см. cancel).
   * TODO: уточнить у бизнеса, возвращается ли serviceFee/taxes при отмене хостом.
   */
  private calculateRefundAmount(
    booking: { totalAmount: number; checkIn: Date },
    isHost: boolean,
  ): number {
    if (isHost) return booking.totalAmount;

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const checkIn = new Date(booking.checkIn);
    checkIn.setUTCHours(0, 0, 0, 0);

    const daysUntilCheckIn = Math.round(
      (checkIn.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );

    if (daysUntilCheckIn >= FULL_REFUND_DAYS_BEFORE_CHECKIN) {
      return booking.totalAmount;
    }
    return Math.floor(booking.totalAmount * 0.5);
  }
}
