import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module.js';
import { TasksService } from './tasks.service.js';

@Module({
  imports: [PrismaModule],
  providers: [TasksService],
})
export class TasksModule {}
