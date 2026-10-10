import { Controller, Post, Body } from '@nestjs/common';
import { Session, Roles } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { BookingsService } from './bookings.service.js';
import { CreateCheckoutDto } from './dto/create-checkout.dto.js';

@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookingsService: BookingsService) {}

  @Post('checkout')
  @Roles(['GUEST', 'HOST']) // И гости, и хосты могут быть гостями в других бронированиях
  async createCheckout(
    @Body() dto: CreateCheckoutDto,
    @Session() session: UserSession,
  ) {
    return this.bookingsService.createCheckoutSession(
      dto.bookingId,
      session.user.id,
    );
  }
}
