import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { auth } from './auth.js';
import { StripeService } from './stripe/stripe.service.js';
import { BookingsModule } from './bookings/bookings.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { PropertiesModule } from './properties/properties.module.js';
import { ImagesModule } from './images/images.module.js';
import { ImageKitModule } from './imagekit/imagekit.module.js';
import { AvailabilityModule } from './availability/availability.module.js';
import { PricingModule } from './pricing/pricing.module.js';
import { ScheduleModule } from '@nestjs/schedule';
import { TasksModule } from './tasks/tasks.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule.forRoot({ auth: auth }),
    BookingsModule,
    WebhooksModule,
    PropertiesModule,
    ImageKitModule,
    ImagesModule,
    PricingModule,
    AvailabilityModule,
    TasksModule,
  ],
  controllers: [AppController],
  providers: [AppService, StripeService],
})
export class AppModule {}
