import { Module } from '@nestjs/common';
import { StripeWebhookController } from './webhooks.controller.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { StripeModule } from '../stripe/stripe.module.js';

@Module({
  imports: [PrismaModule, StripeModule],
  controllers: [StripeWebhookController],
})
export class WebhooksModule {}
