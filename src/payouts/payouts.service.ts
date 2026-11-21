import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Actor } from '../common/auth/actor.js';
import { UserRole, PayoutStatus } from '../generated/prisma/client.js';

@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ============================================================
  // 1. СОЗДАНИЕ PAYOUT ДЛЯ ЗАВЕРШЁННОЙ БРОНИ (вызывается из cron)
  // ============================================================

  /**
   * Создаёт Payout для COMPLETED брони, если его ещё нет.
   * Идемпотентно: повторный вызов для той же брони вернёт существующий Payout.
   */
  async createForCompletedBooking(bookingId: string): Promise<void> {
    // Проверяем, что бронь COMPLETED и Payout ещё нет
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      select: {
        id: true,
        hostId: true,
        status: true,
        hostPayoutAmount: true,
        currency: true,
        code: true,
      },
    });

    if (!booking) {
      this.logger.warn(
        `createForCompletedBooking: booking ${bookingId} not found`,
      );
      return;
    }
    if (booking.status !== 'COMPLETED') {
      this.logger.warn(
        `createForCompletedBooking: booking ${bookingId} is ${booking.status}, not COMPLETED`,
      );
      return;
    }

    // Проверяем, нет ли уже Payout для этой брони
    const existing = await this.prisma.payout.findFirst({
      where: { bookingId: booking.id },
    });
    if (existing) {
      return; // уже создан — идемпотентность
    }

    // Создаём Payout
    const payout = await this.prisma.payout.create({
      data: {
        hostId: booking.hostId,
        bookingId: booking.id,
        amount: booking.hostPayoutAmount,
        currency: booking.currency,
        status: 'PENDING',
        metadata: { bookingCode: booking.code },
      },
    });

    // Уведомляем хоста
    await this.prisma.notification.create({
      data: {
        userId: booking.hostId,
        type: 'PAYOUT_SENT', // или создать новый тип, если нужно
        channel: 'IN_APP',
        title: 'Выплата ожидает обработки',
        body: `По брони #${booking.code} начислена выплата ${booking.hostPayoutAmount / 100} ${booking.currency}. Ожидает перевода.`,
        data: { payoutId: payout.id, bookingId: booking.id },
      },
    });

    this.logger.log(
      `Payout created: id=${payout.id}, hostId=${booking.hostId}, amount=${booking.hostPayoutAmount} ${booking.currency}, booking=${booking.code}`,
    );
  }

  // ============================================================
  // 2. СПИСОК ВЫПЛАТ ХОСТА
  // ============================================================

  async findMy(actor: Actor) {
    return this.prisma.payout.findMany({
      where: { hostId: actor.id },
      orderBy: { createdAt: 'desc' },
      include: {
        // Если хочешь показать, за какую бронь
        // booking: { select: { id: true, code: true, checkIn: true } },
      },
    });
  }

  // ============================================================
  // 3. СПИСОК ВСЕХ ВЫПЛАТ (АДМИН)
  // ============================================================

  async findAll(query: {
    status?: PayoutStatus;
    hostId?: string;
    limit?: number;
    offset?: number;
  }) {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.hostId) where.hostId = query.hostId;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.payout.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          host: { select: { id: true, name: true, email: true } },
        },
      }),
      this.prisma.payout.count({ where }),
    ]);

    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }

  // ============================================================
  // 4. ОТМЕТИТЬ PAYOUT КАК ВЫПЛАЧЕННЫЙ (АДМИН)
  // ============================================================

  async markPaid(payoutId: string, actor: Actor, stripeTransferId?: string) {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Только админ может отмечать выплаты');
    }

    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
    });
    if (!payout) {
      throw new NotFoundException('Выплата не найдена');
    }
    if (payout.status !== 'PENDING') {
      throw new BadRequestException(
        `Нельзя выплатить Payout в статусе ${payout.status}`,
      );
    }

    const updated = await this.prisma.payout.update({
      where: { id: payoutId },
      data: {
        status: 'PAID',
        paidAt: new Date(),
        stripeTransferId: stripeTransferId ?? null,
      },
    });

    // Уведомляем хоста
    await this.prisma.notification.create({
      data: {
        userId: payout.hostId,
        type: 'PAYOUT_SENT',
        channel: 'IN_APP',
        title: 'Выплата произведена',
        body: `Выплата ${payout.amount / 100} ${payout.currency} переведена.`,
        data: { payoutId: payout.id },
      },
    });

    // AuditLog
    await this.prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'payout.mark_paid',
        entityType: 'Payout',
        entityId: payout.id,
        before: { status: 'PENDING' },
        after: { status: 'PAID', stripeTransferId },
      },
    });

    this.logger.log(
      `Payout ${payoutId} marked as PAID by admin ${actor.id}, transfer=${stripeTransferId ?? 'manual'}`,
    );

    return updated;
  }

  // ============================================================
  // 5. ОТМЕТИТЬ PAYOUT КАК FAILED (АДМИН)
  // ============================================================

  async markFailed(payoutId: string, reason: string, actor: Actor) {
    if (actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Только админ может менять статус выплат');
    }

    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
    });
    if (!payout) {
      throw new NotFoundException('Выплата не найдена');
    }
    if (payout.status === 'PAID') {
      throw new BadRequestException('Нельзя изменить выплаченный Payout');
    }

    const updated = await this.prisma.payout.update({
      where: { id: payoutId },
      data: {
        status: 'FAILED',
        failureReason: reason,
      },
    });

    await this.prisma.auditLog.create({
      data: {
        actorId: actor.id,
        action: 'payout.mark_failed',
        entityType: 'Payout',
        entityId: payout.id,
        before: { status: payout.status },
        after: { status: 'FAILED', failureReason: reason },
      },
    });

    this.logger.log(`Payout ${payoutId} marked as FAILED: ${reason}`);

    return updated;
  }
}
