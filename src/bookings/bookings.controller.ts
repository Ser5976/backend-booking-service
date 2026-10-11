import { Controller, Post, Body, Get, Query, BadRequestException } from '@nestjs/common';
import { Session, Roles } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { BookingsService } from './bookings.service.js';
import { CreateCheckoutDto } from './dto/create-checkout.dto.js';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post('checkout')
  @Roles(['GUEST', 'HOST'])
  async createCheckout(
    @Body() dto: CreateCheckoutDto,
    @Session() session: UserSession,
  ) {
    return this.bookingsService.createCheckoutSession(
      dto.bookingId,
      session.user.id,
    );
  }

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
    return this.bookingsService.verifyPaymentBySession(sessionId, session.user.id);
  }
}