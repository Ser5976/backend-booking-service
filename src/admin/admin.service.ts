import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { QueryUsersDto } from './dto/query-users.dto.js';
import { SetRoleDto } from './dto/set-role.dto.js';
import { Actor } from '../common/auth/actor.js';
import { UserRole, UserStatus } from '../generated/prisma/client.js';

@Injectable()
export class AdminService {
  constructor(private readonly prisma: PrismaService) {}

  // ============================================================
  // СПИСОК ПОЛЬЗОВАТЕЛЕЙ
  // ============================================================

  async listUsers(query: QueryUsersDto) {
    const where: any = {};

    if (query.role) where.role = query.role;
    if (query.status) where.status = query.status;
    if (query.search) {
      where.OR = [
        { email: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: {
          id: true,
          email: true,
          name: true,
          role: true,
          status: true,
          emailVerified: true,
          createdAt: true,
          deletedAt: true,
          _count: {
            select: {
              properties: true,
              bookings: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }

  async findUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        status: true,
        emailVerified: true,
        phone: true,
        bio: true,
        locale: true,
        timezone: true,
        stripeCustomerId: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        _count: {
          select: {
            properties: true,
            bookings: true,
            reviewsAuthored: true,
            reviewsReceived: true,
            sessions: true,
          },
        },
      },
    });

    if (!user) throw new NotFoundException('Пользователь не найден');
    return user;
  }

  // ============================================================
  // СМЕНА РОЛИ
  // ============================================================

  async setRole(userId: string, dto: SetRoleDto, actor: Actor) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, status: true },
    });
    if (!user) throw new NotFoundException('Пользователь не найден');
    if (user.status === UserStatus.DELETED) {
      throw new BadRequestException(
        'Нельзя менять роль удалённого пользователя',
      );
    }

    // Нельзя снять роль ADMIN с самого себя — чтобы не остаться без админов
    if (user.id === actor.id && dto.role !== UserRole.ADMIN) {
      throw new BadRequestException('Нельзя снять роль ADMIN с самого себя');
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { role: dto.role },
      select: { id: true, email: true, role: true, status: true },
    });
  }

  // ============================================================
  // БЛОКИРОВКА / ВОССТАНОВЛЕНИЕ
  // ============================================================

  async suspend(userId: string, actor: Actor) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!user) throw new NotFoundException('Пользователь не найден');
    if (user.status === UserStatus.DELETED) {
      throw new BadRequestException('Пользователь уже удалён');
    }
    if (user.id === actor.id) {
      throw new BadRequestException('Нельзя заблокировать самого себя');
    }

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: userId },
        data: { status: UserStatus.SUSPENDED },
      }),
      // Удаляем сессии, чтобы разлогинить
      this.prisma.session.deleteMany({ where: { userId } }),
    ]);

    return { ok: true };
  }

  async restore(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!user) throw new NotFoundException('Пользователь не найден');
    if (user.status === UserStatus.ACTIVE) {
      return { ok: true }; // уже активен
    }

    return this.prisma.user.update({
      where: { id: userId },
      data: { status: UserStatus.ACTIVE, deletedAt: null },
      select: { id: true, email: true, role: true, status: true },
    });
  }

  // ============================================================
  // МЯГКОЕ УДАЛЕНИЕ ОТ ИМЕНИ АДМИНА
  // ============================================================

  async deleteUser(userId: string, actor: Actor) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true, email: true },
    });
    if (!user) throw new NotFoundException('Пользователь не найден');
    if (user.status === UserStatus.DELETED) {
      return { ok: true };
    }
    if (user.id === actor.id) {
      throw new BadRequestException('Нельзя удалить самого себя');
    }

    const activeBookings = await this.prisma.booking.count({
      where: {
        OR: [{ guestId: userId }, { hostId: userId }],
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
    });
    if (activeBookings > 0) {
      throw new BadRequestException(
        'Нельзя удалить: есть активные брони. Сначала отмените или завершите их.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          status: UserStatus.DELETED,
          deletedAt: new Date(),
          email: `deleted-${userId}@deleted.local`,
          emailVerified: false,
        },
      });
      await tx.property.updateMany({
        where: { hostId: userId, deletedAt: null },
        data: { status: 'ARCHIVED', deletedAt: new Date() },
      });
      await tx.session.deleteMany({ where: { userId } });
      await tx.account.deleteMany({ where: { userId } });
    });

    return { ok: true };
  }
}
