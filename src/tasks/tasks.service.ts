import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Фоновые задачи. Запускаются раз в 6 часов (00:00, 06:00, 12:00, 18:00 UTC).
 * На бесплатном Neon — чтобы не держать compute активным 24/7.
 * На бесплатном Render — сервис засыпает через 15 мин без HTTP-трафика,
 * поэтому крон не срабатывает, пока сервис спит. При первом запросе
 * после пробуждения следующий крон выполнится в ближайший слот.
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * PENDING → EXPIRED, если expiresAt < now.
   * Освобождает даты в календаре.
   */
  @Cron('0 */6 * * *')
  async expirePendingBookings() {
    const now = new Date();

    const result = await this.prisma.booking.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: now, not: null },
      },
      data: {
        status: 'EXPIRED',
      },
    });

    if (result.count > 0) {
      this.logger.log(
        `Expired ${result.count} pending booking(s) at ${now.toISOString()}`,
      );
    }
  }

  /**
   * CONFIRMED → COMPLETED, если checkOut < сегодня.
   * checkOut — день выезда; завершаем на следующий день.
   * Уведомляет гостя о возможности оставить отзыв.
   */
  @Cron('0 */6 * * *')
  async completeFinishedBookings() {
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );

    const toComplete = await this.prisma.booking.findMany({
      where: {
        status: 'CONFIRMED',
        checkOut: { lt: today },
      },
      select: { id: true, guestId: true, code: true },
    });

    if (toComplete.length === 0) return;

    await this.prisma.$transaction([
      this.prisma.booking.updateMany({
        where: { id: { in: toComplete.map((b) => b.id) } },
        data: { status: 'COMPLETED', completedAt: now },
      }),
      this.prisma.notification.createMany({
        data: toComplete.map((b) => ({
          userId: b.guestId,
          type: 'BOOKING_REMINDER',
          channel: 'IN_APP',
          title: 'Как прошла поездка?',
          body: `Бронь #${b.code} завершена. Оставьте отзыв о проживании.`,
          data: { bookingId: b.id },
        })),
      }),
    ]);

    this.logger.log(
      `Completed ${toComplete.length} finished booking(s) at ${now.toISOString()}`,
    );
  }
}
