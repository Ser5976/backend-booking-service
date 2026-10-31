import { Module } from '@nestjs/common';
import { BookingsService } from './bookings.service.js';
import { BookingsController } from './bookings.controller.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AvailabilityModule } from '../availability/availability.module.js';
import { PricingModule } from '../pricing/pricing.module.js';

@Module({
  imports: [PrismaModule, AvailabilityModule, PricingModule],
  controllers: [BookingsController],
  providers: [BookingsService],
  exports: [BookingsService],
})
export class BookingsModule {}
