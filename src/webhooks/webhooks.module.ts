import { Module } from '@nestjs/common';
import { StripeWebhookController } from './webhooks.controller.js';

@Module({
  controllers: [StripeWebhookController],
})
export class WebhooksModule {}
