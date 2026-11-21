import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PayoutsService } from '../payouts/payouts.service.js';

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
    private readonly payouts: PayoutsService,
  ) {}

  /**
   * PENDING → EXPIRED, если expiresAt < now.
   * Освобождает даты, уведомляет гостя, помечает платёж FAILED.
   *
   * Крон: раз в 6 часов.
   * Почему 6 часов: компромисс между «быстро освободить даты» и
   * «не дёргать бесплатный Neon слишком часто». Ленивая проверка
   * в createCheckoutSession/cancel закрывает срочные случаи.
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
   *
   * Крон: раз в 6 часов.
   * Завершаем на следующий день после checkOut — гость выезжает утром,
   * и только после этого бронь считается завершённой.
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

  /**
   * Создаёт Payout для COMPLETED броней, у которых его ещё нет.
   * Идемпотентно: повторный вызов для той же брони не создаст дубль.
   *
   * Крон: раз в 6 часов.
   * Запускается после completeFinishedBookings (в том же тике), но
   * порядок в @nestjs/schedule не гарантирован. Поэтому здесь
   * ищем все COMPLETED без Payout — независимо от того, кто их завершил.
   *
   * Почему не в completeFinishedBookings:
   * - Разделение ответственности: завершение брони и финансы — разные задачи.
   * - Если создание Payout упадёт, завершение брони всё равно пройдёт.
   * - Легче тестировать отдельно.
   */
  @Cron('0 */6 * * *')
  async createPayoutsForCompletedBookings() {
    // Находим COMPLETED брони без Payout.
    // Prisma не умеет «нет связанных» напрямую, поэтому два запроса:
    // 1) все COMPLETED, 2) у кого уже есть Payout — исключаем.
    const completed = await this.prisma.booking.findMany({
      where: { status: 'COMPLETED' },
      select: { id: true },
    });

    if (completed.length === 0) return;

    const existingPayouts = await this.prisma.payout.findMany({
      where: { bookingId: { in: completed.map((b) => b.id) } },
      select: { bookingId: true },
    });
    const withPayout = new Set(
      existingPayouts.map((p) => p.bookingId).filter(Boolean) as string[],
    );

    const toProcess = completed.filter((b) => !withPayout.has(b.id));

    if (toProcess.length === 0) return;

    for (const booking of toProcess) {
      await this.payouts.createForCompletedBooking(booking.id);
    }

    this.logger.log(
      `Created ${toProcess.length} payout(s) for completed bookings`,
    );
  }

  /**
   * Отправляет все EMAIL-уведомления, которые ещё не отправлены.
   * Вызывается из NotificationsService (батч по 50).
   *
   * Крон: раз в 6 часов.
   * Почему не чаще: Resend имеет лимиты на бесплатном плане,
   * а уведомления не критичны к задержке в несколько часов.
   */
  @Cron('0 */6 * * *')
  async sendPendingEmails() {
    await this.notifications.sendPendingEmails();
  }
}
