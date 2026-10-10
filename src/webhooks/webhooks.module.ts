import { Module } from '@nestjs/common';
import { StripeWebhookController } from './webhooks.controller.js';
import { PrismaModule } from '../prisma/prisma.module.js';

@Module({
  imports: [PrismaModule],
  controllers: [StripeWebhookController],
})
export class WebhooksModule {}
