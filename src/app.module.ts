import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';

import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from '@thallesp/nestjs-better-auth';
import { auth } from './auth.js';
import { StripeModule } from './stripe/stripe.module.js';
import { BookingsModule } from './bookings/bookings.module.js';
import { WebhooksModule } from './webhooks/webhooks.module.js';
import { PropertiesModule } from './properties/properties.module.js';
import { ImagesModule } from './images/images.module.js';
import { ImageKitModule } from './imagekit/imagekit.module.js';
import { AvailabilityModule } from './availability/availability.module.js';
import { PricingModule } from './pricing/pricing.module.js';
import { TasksModule } from './tasks/tasks.module.js';
import { ReviewsModule } from './reviews/reviews.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { UsersModule } from './users/users.module.js';
import { AdminModule } from './admin/admin.module.js';
import { PayoutsModule } from './payouts/payouts.module.js';
import { FavoritesModule } from './favorites/favorites.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      { ttl: 60_000, limit: 60 }, // общий лимит: 60 запросов/мин
    ]),
    PrismaModule,
    AuthModule.forRoot({ auth }),
    StripeModule,
    BookingsModule,
    WebhooksModule,
    PropertiesModule,
    ImageKitModule,
    ImagesModule,
    PricingModule,
    AvailabilityModule,
    TasksModule,
    ReviewsModule,
    NotificationsModule,
    UsersModule,
    AdminModule,
    PayoutsModule,
    FavoritesModule,
  ],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
