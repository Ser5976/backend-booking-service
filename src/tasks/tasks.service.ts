import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

/**
 * Фоновые задачи. Запускаются раз в 6 часов (00:00, 06:00, 12:00, 18:00 UTC).
 * На бесплатном Neon — чтобы не держать compute активным 24/7.
 * На бесплатном Render — сервис засыпает через 15 мин без HTTP-трафика,
 * поэтому крон не срабатывает, пока сервис спит. При первом запросе
 * после пробуждения следующий крон выполнится в ближайший слот.
 *
 * ВАЖНО: ленивая проверка expiresAt есть в BookingsService.createCheckoutSession
 * и BookingsService.cancel — она закрывает случаи, когда крон не успел.
 */
@Injectable()
export class TasksService {
  private readonly logger = new Logger(TasksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * PENDING → EXPIRED, если expiresAt < now.
   * Освобождает даты, уведомляет гостя, помечает платёж FAILED.
   */
  @Cron('0 */6 * * *')
  async expirePendingBookings() {
    const now = new Date();

    const toExpire = await this.prisma.booking.findMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: now, not: null },
      },
      select: { id: true, guestId: true, code: true },
    });

    if (toExpire.length === 0) return;

    await this.prisma.$transaction([
      // Ещё раз фильтруем по status: 'PENDING' — защита от гонки с webhook.
      this.prisma.booking.updateMany({
        where: {
          id: { in: toExpire.map((b) => b.id) },
          status: 'PENDING',
        },
        data: { status: 'EXPIRED' },
      }),
      this.prisma.payment.updateMany({
        where: {
          bookingId: { in: toExpire.map((b) => b.id) },
          status: 'PENDING',
        },
        data: {
          status: 'FAILED',
          failureReason: 'Payment timeout',
        },
      }),
      this.prisma.notification.createMany({
        data: toExpire.map((b) => ({
          userId: b.guestId,
          type: 'PAYMENT_FAILED',
          channel: 'IN_APP',
          title: 'Срок оплаты истек',
          body: `Время на оплату брони #${b.code} истекло. Бронь отменена.`,
          data: { bookingId: b.id },
        })),
      }),
    ]);

    this.logger.log(
      `Expired ${toExpire.length} pending booking(s) at ${now.toISOString()}`,
    );
  }

  /**
   * CONFIRMED → COMPLETED, если checkOut < сегодня.
   * Уведомляет гостя о возможности оставить отзыв (только если отзыва ещё нет).
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
        review: null, // не спамим тех, кто уже оставил отзыв
      },
      select: { id: true, guestId: true, code: true },
    });

    if (toComplete.length === 0) return;

    await this.prisma.$transaction([
      this.prisma.booking.updateMany({
        where: {
          id: { in: toComplete.map((b) => b.id) },
          status: 'CONFIRMED', // защита от гонки с cancel
        },
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

  @Cron('0 */6 * * *')
  async sendPendingEmails() {
    await this.notifications.sendPendingEmails();
  }
}
