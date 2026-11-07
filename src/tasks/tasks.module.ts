import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TasksService } from './tasks.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';

@Module({
  imports: [PrismaModule, NotificationsModule],
  providers: [TasksService],
})
export class TasksModule {}
