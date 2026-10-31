import {
  Controller,
  Post,
  Body,
  Get,
  Query,
  Param,
  BadRequestException,
} from '@nestjs/common';
import { Session, Roles } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { BookingsService } from './bookings.service.js';
import { CreateCheckoutDto } from './dto/create-checkout.dto.js';
import { CreateBookingDto } from './dto/create-booking.dto.js';
import { QueryBookingsDto } from './dto/query-bookings.dto.js';
import { toActor } from '../common/auth/actor.js';
import { CancelBookingDto } from './dto/cancel-booking.dto.js';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  // ============================================================
  // СОЗДАНИЕ БРОНИ
  // ============================================================

  /**
   * POST /bookings — создать бронь со статусом PENDING.
   * Дальше фронтенд вызывает POST /bookings/checkout с bookingId.
   */
  @Post()
  @Roles(['GUEST', 'HOST'])
  create(@Body() dto: CreateBookingDto, @Session() session: UserSession) {
    return this.bookingsService.create(dto, toActor(session.user));
  }

  // ============================================================
  // СТАТИЧЕСКИЕ МАРШРУТЫ (должны идти ДО @Get(':id'))
  // ============================================================

  /**
   * POST /bookings/checkout — создать Stripe Checkout Session.
   */
  @Post('checkout')
  @Roles(['GUEST', 'HOST'])
  createCheckout(
    @Body() dto: CreateCheckoutDto,
    @Session() session: UserSession,
  ) {
    return this.bookingsService.createCheckoutSession(
      dto.bookingId,
      session.user.id,
    );
  }

  /**
   * GET /bookings/verify-payment?session_id=...
   * Fallback-проверка оплаты, если webhook ещё не дошёл.
   */
  @Get('verify-payment')
  @Roles(['GUEST', 'HOST'])
  async verifyPayment(
    @Query('session_id') sessionId: string,
    @Session() session: UserSession,
  ): Promise<{
    status: string;
    booking?: any;
    paymentStatus?: string;
    message?: string;
  }> {
    if (!sessionId) {
      throw new BadRequestException('session_id is required');
    }
    return this.bookingsService.verifyPaymentBySession(
      sessionId,
      session.user.id,
    );
  }

  /**
   * GET /bookings/my?role=guest|host&status=...&limit=...&offset=...
   * role=guest (по умолчанию) — мои поездки.
   * role=host — брони на мои объявления.
   */
  @Get('my')
  @Roles(['GUEST', 'HOST', 'ADMIN'])
  findMy(@Query() query: QueryBookingsDto, @Session() session: UserSession) {
    return this.bookingsService.findMy(toActor(session.user), query);
  }

  // ============================================================
  // ДИНАМИЧЕСКИЙ МАРШРУТ (должен быть ПОСЛЕДНИМ)
  // ============================================================

  /**
   * GET /bookings/:id — детали брони. Доступ: гость, хост, админ.
   */
  @Get(':id')
  @Roles(['GUEST', 'HOST', 'ADMIN'])
  findOne(@Param('id') id: string, @Session() session: UserSession) {
    return this.bookingsService.findOne(id, toActor(session.user));
  }

  /**
   * POST /bookings/:id/cancel — отмена брони с возвратом.
   */
  @Post(':id/cancel')
  @Roles(['GUEST', 'HOST', 'ADMIN'])
  cancel(
    @Param('id') id: string,
    @Body() dto: CancelBookingDto,
    @Session() session: UserSession,
  ) {
    return this.bookingsService.cancel(id, dto, toActor(session.user));
  }
}
