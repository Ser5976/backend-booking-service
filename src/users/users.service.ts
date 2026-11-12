import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { ConflictException } from '@nestjs/common';

/** Публичные поля, которые можно отдавать всем */
const PUBLIC_USER_SELECT = {
  id: true,
  name: true,
  image: true,
  bio: true,
  createdAt: true,
} as const;

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Профиль текущего пользователя (полный, для себя).
   * Читаем из БД, а не из session.user, потому что additionalFields
   * (role, status, stripeCustomerId) могут не попадать в сессию.
   */
  async findMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        emailVerified: true,
        name: true,
        image: true,
        phone: true,
        role: true,
        status: true,
        stripeCustomerId: true,
        bio: true,
        locale: true,
        timezone: true,
        lastLoginAt: true,
        createdAt: true,
      },
    });

    if (!user) throw new NotFoundException('Пользователь не найден');
    return user;
  }

  /**
   * Публичный профиль (для страницы хоста на объявлении).
   * Без email, stripeCustomerId, status — только то, что можно показывать всем.
   */
  async findPublic(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        ...PUBLIC_USER_SELECT,
        status: true, // ← добавили для проверки
        properties: {
          where: { status: 'PUBLISHED', deletedAt: null },
          select: {
            id: true,
            title: true,
            slug: true,
            city: true,
            country: true,
            avgRating: true,
            reviewsCount: true,
            basePricePerNight: true,
            currency: true,
            images: { where: { isCover: true }, take: 1 },
          },
          orderBy: { publishedAt: 'desc' },
          take: 10,
        },
        _count: {
          select: {
            reviewsReceived: { where: { isPublished: true } },
            properties: { where: { status: 'PUBLISHED', deletedAt: null } },
          },
        },
      },
    });

    if (!user || user.status === 'DELETED') {
      throw new NotFoundException('Пользователь не найден');
    }

    // Убираем status из ответа — фронтенду он не нужен
    const { status, ...publicUser } = user;
    return publicUser;
  }

  /**
   * Обновление своего профиля.
   * role/status/email/stripeCustomerId менять нельзя — только профильные поля.
   */
  async updateMe(userId: string, dto: UpdateUserDto) {
    const existing = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Пользователь не найден');

    return this.prisma.user.update({
      where: { id: userId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.bio !== undefined && { bio: dto.bio }),
        ...(dto.image !== undefined && { image: dto.image }),
        ...(dto.locale !== undefined && { locale: dto.locale }),
        ...(dto.timezone !== undefined && { timezone: dto.timezone }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        phone: true,
        role: true,
        bio: true,
        locale: true,
        timezone: true,
        updatedAt: true,
      },
    });
  }
  /**
   * Удаление своего профиля.
   Soft delete (мягкое удаление)
   */
  async deleteMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, status: true },
    });
    if (!user) throw new NotFoundException('Пользователь не найден');
    if (user.status === 'DELETED') {
      return { ok: true }; // идемпотентно
    }

    // Проверяем активные брони как гость или хост
    const activeBookings = await this.prisma.booking.count({
      where: {
        OR: [{ guestId: userId }, { hostId: userId }],
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
    });
    if (activeBookings > 0) {
      throw new ConflictException(
        'Нельзя удалить аккаунт: есть активные брони. Отмените или дождитесь их завершения.',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      // 1. Soft-delete пользователя + освобождаем email
      await tx.user.update({
        where: { id: userId },
        data: {
          status: 'DELETED',
          deletedAt: new Date(),
          email: `deleted-${userId}@deleted.local`,
          emailVerified: false,
        },
      });

      // 2. Архивируем объявления
      await tx.property.updateMany({
        where: { hostId: userId, deletedAt: null },
        data: { status: 'ARCHIVED', deletedAt: new Date() },
      });

      // 3. Удаляем сессии (разлогиниваем везде)
      await tx.session.deleteMany({ where: { userId } });

      // 4. Удаляем OAuth/credential аккаунты
      await tx.account.deleteMany({ where: { userId } });
    });

    return { ok: true };
  }
}
