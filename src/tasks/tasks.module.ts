import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TasksService } from './tasks.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PayoutsModule } from '../payouts/payouts.module.js';

@Module({
  imports: [PrismaModule, NotificationsModule, PayoutsModule],
  providers: [TasksService],
})
export class TasksModule {}
