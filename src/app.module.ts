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

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule.forRoot({ auth: auth }),
    BookingsModule,
    WebhooksModule,
  ],
  controllers: [AppController],
  providers: [AppService, StripeService],
})
export class AppModule {}
