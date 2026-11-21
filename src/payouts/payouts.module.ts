import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PayoutsController } from './payouts.controller.js';
import { PayoutsService } from './payouts.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [PayoutsController],
  providers: [PayoutsService],
  exports: [PayoutsService],
})
export class PayoutsModule {}
