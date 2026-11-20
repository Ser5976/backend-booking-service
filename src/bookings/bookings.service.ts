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

// Алфавит для генерации кода брони.
// Исключены похожие символы (0/O, 1/I/L), чтобы код было легко читать вслух.
const BOOKING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// Сколько минут даётся гостю на оплату брони после её создания.
const PAYMENT_TIMEOUT_MINUTES = 30;

@Injectable()
export class BookingsService {
  // Экземпляр Stripe-клиента, создаётся один раз при инициализации сервиса.
  private readonly stripe: Stripe;

  constructor(
    private readonly prisma: PrismaService,
    private readonly availability: AvailabilityService,
    private readonly pricing: PricingService,
  ) {
    // Инициализируем Stripe секретным ключом из переменных окружения.
    this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
      apiVersion: '2026-09-30.endive',
    });
  }

  // ============================================================
  // 1. СОЗДАНИЕ БРОНИ
  // ============================================================

  async create(dto: CreateBookingDto, actor: Actor) {
    // 1.1. Проверяем, что объявление существует и не удалено.
    //      Заодно подтягиваем обложку и данные хоста для снапшота.
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
    // Объявление должно быть опубликовано, иначе бронировать нельзя.
    if (property.status !== 'PUBLISHED') {
      throw new BadRequestException('Объявление недоступно для бронирования');
    }
    // Хост не может бронировать собственное объявление.
    if (property.hostId === actor.id) {
      throw new BadRequestException(
        'Нельзя бронировать собственное объявление',
      );
    }

    // 1.2. Базовая проверка дат:
    //      - checkOut строго позже checkIn;
    //      - checkIn не в прошлом (сравниваем по строке YYYY-MM-DD).
    if (dto.checkIn >= dto.checkOut) {
      throw new BadRequestException('checkOut должен быть позже checkIn');
    }
    const today = new Date().toISOString().slice(0, 10);
    if (dto.checkIn < today) {
      throw new BadRequestException('Нельзя бронировать прошедшие даты');
    }

    // 1.3. Быстрая предварительная проверка занятости дат (вне транзакции).
    //      Это оптимизация: если даты уже заняты — сразу отдаём 409,
    //      не доходя до тяжёлой транзакции. Окончательная проверка — внутри неё.
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

    // 1.4. Считаем итоговую цену брони (ночи, сборы, налоги, скидки и т.д.).
    const price = await this.pricing.calculatePrice({
      propertyId: dto.propertyId,
      checkIn: dto.checkIn,
      checkOut: dto.checkOut,
      guests: dto.guests,
    });

    // 1.5. Загружаем данные гостя — нужны для снапшота и customer_email в Stripe.
    const guest = await this.prisma.user.findUnique({
      where: { id: actor.id },
      select: { id: true, email: true, name: true },
    });
    if (!guest) {
      throw new NotFoundException('Пользователь не найден');
    }

    // 1.6. Формируем снапшоты: фиксируем состояние объявления и гостя
    //      на момент бронирования, чтобы история не «плыла» при изменении данных.
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

    // 1.7. Транзакция: advisory lock → повторная проверка занятости → создание → уведомление.
    //      Делаем до 3 попыток на случай коллизии по уникальному коду брони (P2002).
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          // Берём advisory-лок на propertyId, чтобы два параллельных запроса
          // на одно и то же объявление не создали пересекающиеся брони.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${dto.propertyId}))`;

          // Повторно проверяем пересечение дат уже внутри транзакции:
          // между предварительной проверкой и транзакцией даты могли занять.
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

          // Создаём бронь в статусе PENDING (ожидает оплаты).
          // Все денежные значения и снапшоты фиксируются сразу.
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
              // Дедлайн оплаты: если гость не оплатит за N минут — бронь протухнет.
              expiresAt: new Date(
                Date.now() + PAYMENT_TIMEOUT_MINUTES * 60 * 1000,
              ),
            },
          });

          // Уведомляем хоста о новой брони (пока только в очереди на EMAIL).
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

          return booking;
        });
      } catch (e: any) {
        // Коллизия по уникальному коду брони — пробуем ещё раз (до 3 попыток).
        if (e?.code === 'P2002' && attempt < 2) continue;
        throw e;
      }
    }

    // Если все попытки провалились — отдаём понятную ошибку.
    throw new BadRequestException(
      'Не удалось создать бронь, попробуйте ещё раз',
    );
  }

  // ============================================================
  // 2. ОПЛАТА ЧЕРЕЗ STRIPE (CHECKOUT SESSION)
  // ============================================================

  async createCheckoutSession(bookingId: string, userId: string) {
    // 2.1. Загружаем бронь вместе с объявлением (нужно название для Stripe).
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { property: true },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    // 2.2. Оплатить можно только свою бронь.
    if (booking.guestId !== userId) {
      throw new ForbiddenException('You can only pay for your own bookings');
    }

    // 2.3. Оплата возможна только для брони в статусе PENDING.
    if (booking.status !== 'PENDING') {
      throw new BadRequestException('Booking is not awaiting payment');
    }
    // Проверяем, не истёк ли срок оплаты (крон может ещё не успеть).
    if (booking.expiresAt && booking.expiresAt < new Date()) {
      // Сразу помечаем бронь как EXPIRED, чтобы не ждать крона.
      await this.prisma.booking.update({
        where: { id: booking.id },
        data: { status: 'EXPIRED' },
      });
      throw new BadRequestException('Срок оплаты брони истёк');
    }

    // 2.4. Создаём Stripe Checkout Session:
    //      - mode=payment — разовый платёж;
    //      - line_items — одна позиция на всю сумму брони;
    //      - client_reference_id и metadata — чтобы связать сессию с бронью;
    //      - success/cancel URL — куда вернуть пользователя;
    //      - expires_at — сессия живёт 30 минут.
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

    // 2.5. Сохраняем запись о платеже в статусе PENDING,
    //      чтобы потом webhook/verify могли её обновить.
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

    // 2.6. Возвращаем фронту URL, куда редиректить пользователя.
    return { url: session.url };
  }

  // ============================================================
  // 3. ПРОВЕРКА ОПЛАТЫ (FALLBACK ДЛЯ WEBHOOK)
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
    // 3.1. Достаём сессию из Stripe вместе с PaymentIntent.
    const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['payment_intent'],
    });

    // 3.2. В metadata сессии лежит bookingId — без него не понять, что подтверждать.
    const bookingId = session.metadata?.bookingId;
    if (!bookingId) {
      throw new BadRequestException('Invalid session: no bookingId');
    }

    // 3.3. Загружаем бронь по bookingId.
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
    });

    // 3.4. Проверяем, что бронь существует и принадлежит этому пользователю.
    if (!booking || booking.guestId !== userId) {
      throw new ForbiddenException('Not your booking');
    }

    // 3.5. Если бронь уже подтверждена — просто сообщаем об этом (идемпотентность).
    if (booking.status === 'CONFIRMED') {
      return { status: 'already_confirmed', booking };
    }

    // 3.6. Определяем статус оплаты: сначала из PaymentIntent, иначе из сессии.
    const paymentIntent = session.payment_intent as Stripe.PaymentIntent | null;
    const paymentStatus = paymentIntent?.status ?? session.payment_status;

    // 3.7. Если оплата прошла — подтверждаем бронь и обновляем платёж в транзакции.
    if (paymentStatus === 'paid' || session.payment_status === 'paid') {
      await this.prisma.$transaction(async (tx) => {
        // Переводим бронь в CONFIRMED и фиксируем время подтверждения.
        await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: 'CONFIRMED',
            confirmedAt: new Date(),
          },
        });

        // Обновляем запись платежа: статус, время оплаты, id чарджа и т.д.
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

        // Уведомляем гостя об успешном подтверждении брони.
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

    // 3.8. Оплата ещё не завершена — возвращаем промежуточный статус.
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
   * role=guest — где он гость; role=host — где он хост.
   * Сортировка: ближайшие checkIn сверху; прошедшие — в конце.
   */
  async findMy(actor: Actor, query: QueryBookingsDto) {
    // 4.1. По умолчанию смотрим брони, где пользователь — гость.
    const role = query.role ?? 'guest';
    const where: any = {
      status: query.status ? query.status : undefined,
    };

    // 4.2. Фильтруем по роли: гость или хост.
    if (role === 'guest') {
      where.guestId = actor.id;
    } else {
      where.hostId = actor.id;
    }

    // 4.3. Убираем undefined, чтобы Prisma не ругался на пустое условие.
    if (where.status === undefined) delete where.status;

    // 4.4. Пагинация: limit/offset с дефолтами.
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    // 4.5. Двумя запросами в одной транзакции получаем страницу и общее количество.
    const [items, total] = await this.prisma.$transaction([
      this.prisma.booking.findMany({
        where,
        orderBy: [{ checkIn: 'asc' }, { createdAt: 'desc' }],
        skip: offset,
        take: limit,
        include: {
          // Подтягиваем краткую инфу об объявлении и обложку.
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
          // И наличие отзыва (если есть).
          review: { select: { id: true, ratingOverall: true } },
        },
      }),
      this.prisma.booking.count({ where }),
    ]);

    // 4.6. Возвращаем страницу + метаданные пагинации.
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

  /**
   * Детали одной брони. Доступ: гость, хост, админ.
   * Включает property, payments, review.
   */
  async findOne(bookingId: string, actor: Actor) {
    // 5.1. Загружаем бронь со связанными данными:
    //      объявление (адрес, время заезда/выезда, фото),
    //      платежи (история), отзыв (если есть).
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

    // 5.2. Определяем, кем является текущий пользователь по отношению к брони.
    const isGuest = booking.guestId === actor.id;
    const isHost = booking.hostId === actor.id;
    const isAdmin = actor.role === 'ADMIN';

    // 5.3. Если не гость, не хост и не админ — отдаём 404, а не 403,
    //      чтобы не раскрывать существование чужой брони.
    if (!isGuest && !isHost && !isAdmin) {
      throw new NotFoundException('Бронь не найдена');
    }

    return booking;
  }

  // ============================================================
  // 6. ОТМЕНА БРОНИ И ВОЗВРАТ СРЕДСТВ
  // ============================================================

  /**
   * Отмена брони с возвратом через Stripe.
   * - PENDING: без возврата.
   * - CONFIRMED: возврат по правилам (полный/50%/100% при отмене хостом).
   * - Прочие статусы: 400.
   */
  async cancel(bookingId: string, dto: CancelBookingDto, actor: Actor) {
    // 6.1. Загружаем бронь вместе с последним успешным платежом,
    //      у которого есть PaymentIntent (нужен для Stripe Refund).
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

    // 6.2. Проверяем права: гость, хост или админ.
    const isGuest = booking.guestId === actor.id;
    const isHost = booking.hostId === actor.id;
    const isAdmin = actor.role === 'ADMIN';
    if (!isGuest && !isHost && !isAdmin) {
      // Снова 404, чтобы не палить существование чужой брони.
      throw new NotFoundException('Бронь не найдена');
    }

    // 6.3. Отменить можно только PENDING или CONFIRMED.
    const cancellable = ['PENDING', 'CONFIRMED'];
    if (!cancellable.includes(booking.status)) {
      throw new BadRequestException(
        `Нельзя отменить бронь в статусе ${booking.status}`,
      );
    }

    // 6.4. Определяем, кто именно отменяет — от этого зависит статус и сумма возврата.
    const cancelledBy: 'CANCELLED_BY_GUEST' | 'CANCELLED_BY_HOST' = isHost
      ? 'CANCELLED_BY_HOST'
      : 'CANCELLED_BY_GUEST';

    // 6.5. PENDING — оплаты ещё не было, возврат не нужен:
    //      просто меняем статус и фиксируем причину/время отмены.
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

    // 6.6. CONFIRMED — считаем сумму возврата по правилам
    //      (хост/админ — 100%, гость — 100% или 50% в зависимости от срока).
    const refundAmount = this.calculateRefundAmount(booking, isHost || isAdmin);

    // 6.7. Ищем успешный платёж для Stripe Refund.
    const payment = booking.payments[0];
    if (!payment || !payment.stripePaymentIntentId) {
      // Платёж не найден — отменяем бронь без Stripe Refund,
      // создаём запись refund со статусом REJECTED и уведомляем гостя.
      return this.prisma.$transaction(async (tx) => {
        const updated = await tx.booking.update({
          where: { id: bookingId },
          data: {
            status: cancelledBy,
            cancelledAt: new Date(),
            cancellationReason: dto.reason ?? null,
          },
        });

        // Фиксируем неудачную попытку возврата — для аудита и поддержки.
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

        // Уведомляем гостя, что возврат не удалось сделать автоматически.
        await tx.notification.create({
          data: {
            userId: booking.guestId,
            type: 'REFUND_PROCESSED',
            channel: 'EMAIL',
            title: 'Бронь отменена',
            body: `Бронь #${booking.code} отменена. Возврат не может быть обработан автоматически, свяжитесь с поддержкой.`,
            data: { bookingId: booking.id },
          },
        });

        return updated;
      });
    }

    // 6.8. Пытаемся создать возврат в Stripe.
    //      Ошибку не пробрасываем, а сохраняем в stripeError —
    //      чтобы всё равно отменить бронь и зафиксировать проблему.
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

    // 6.9. Обновляем БД в одной транзакции:
    //      бронь → refund → payment → уведомления.
    return this.prisma.$transaction(async (tx) => {
      // 1) Меняем статус брони на CANCELLED_BY_*.
      const updated = await tx.booking.update({
        where: { id: bookingId },
        data: {
          status: cancelledBy,
          cancelledAt: new Date(),
          cancellationReason: dto.reason ?? null,
        },
      });

      // 2) Определяем статус возврата:
      //    - ошибка Stripe → REJECTED;
      //    - succeeded → PROCESSED;
      //    - иначе (pending/requires_action) → REQUESTED.
      const refundStatus = stripeError
        ? 'REJECTED'
        : stripeRefund?.status === 'succeeded'
          ? 'PROCESSED'
          : 'REQUESTED'; // pending или requires_action

      // 3) Создаём запись о возврате.
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

      // 4) Обновляем статус платежа: полный или частичный возврат.
      //    Делаем только если Stripe не вернул ошибку.
      if (!stripeError) {
        const isFullRefund = refundAmount >= booking.totalAmount;
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          },
        });
      }

      // 5) Уведомляем гостя об отмене и результате возврата.
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

      // 6) Если отменил гость — уведомляем хоста, что бронь снята.
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

  // ============================================================
  // 7. ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
  // ============================================================

  /**
   * Генерация кода брони
   * Человекочитаемый код брони: BK-2025-A3F9K2.
   * Без похожих символов (0/O, 1/I/L), чтобы не путать при чтении вслух.
   * Уникальность гарантируется @unique в БД + ретрай в create().
   */
  private generateBookingCode(): string {
    // Год берём текущий (UTC), чтобы код был узнаваемым.
    const year = new Date().getUTCFullYear();
    // Генерируем 6 случайных символов из безопасного алфавита.
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
   * Расчёт возврата
   * Сумма возврата:
   * - Хост/админ отменяет → 100% totalAmount.
   * - Гость, checkIn - today >= 3 дня → 100%.
   * - Гость, меньше 3 дней → 50% (округление вниз).
   */
  private calculateRefundAmount(
    booking: { totalAmount: number; checkIn: Date },
    isHostOrAdmin: boolean,
  ): number {
    // Если отменяет хост или админ — возвращаем всё.
    if (isHostOrAdmin) return booking.totalAmount;

    // Приводим даты к началу дня UTC, чтобы считать целые дни.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const checkIn = new Date(booking.checkIn);
    checkIn.setUTCHours(0, 0, 0, 0);

    // Сколько дней осталось до заезда.
    const daysUntilCheckIn = Math.round(
      (checkIn.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
    );

    // За 3+ дня — полный возврат, иначе — половина (округление вниз).
    if (daysUntilCheckIn >= 3) return booking.totalAmount;
    return Math.floor(booking.totalAmount * 0.5);
  }
}
