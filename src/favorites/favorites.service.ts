import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Actor } from '../common/auth/actor.js';
import { Prisma } from '../generated/prisma/client.js';

@Injectable()
export class FavoritesService {
  constructor(private readonly prisma: PrismaService) {}

  // ============================================================
  // 1. ДОБАВИТЬ В ИЗБРАННОЕ
  // ============================================================

  /**
   * Идемпотентно: если уже в избранном — просто возвращаем существующую запись.
   * P2002 (unique constraint) не бросаем — это ожидаемое поведение.
   */
  async add(propertyId: string, actor: Actor) {
    // Проверяем, что объявление существует и опубликовано.
    // Нельзя добавить в избранное DRAFT/ARCHIVED/удалённое.
    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, status: true, deletedAt: true },
    });
    if (!property || property.deletedAt) {
      throw new NotFoundException('Объявление не найдено');
    }
    if (property.status !== 'PUBLISHED') {
      throw new NotFoundException('Объявление не найдено');
    }

    // upsert — атомарно: создать, если нет; вернуть, если есть.
    // Это идемпотентно и не бросает P2002.
    return this.prisma.favorite.upsert({
      where: {
        userId_propertyId: { userId: actor.id, propertyId },
      },
      create: { userId: actor.id, propertyId },
      update: {}, // ничего не меняем, если уже есть
    });
  }

  // ============================================================
  // 2. УБРАТЬ ИЗ ИЗБРАННОГО
  // ============================================================

  /**
   * Идемпотентно: если записи нет — не ошибка, просто 204.
   * deleteMany не бросает P2025 (в отличие от delete).
   */
  async remove(propertyId: string, actor: Actor) {
    await this.prisma.favorite.deleteMany({
      where: { userId: actor.id, propertyId },
    });
    return { ok: true };
  }

  // ============================================================
  // 3. СПИСОК ИЗБРАННОГО
  // ============================================================

  /**
   * Список избранных объявлений с пагинацией.
   * Сортировка: сначала недавно добавленные.
   * Включает обложку и краткую инфу об объявлении.
   */
  async list(actor: Actor, query: { limit?: number; offset?: number }) {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.favorite.findMany({
        where: { userId: actor.id },
        orderBy: { createdAt: 'desc' },
        skip: offset,
        take: limit,
        include: {
          property: {
            select: {
              id: true,
              title: true,
              slug: true,
              city: true,
              country: true,
              type: true,
              basePricePerNight: true,
              currency: true,
              avgRating: true,
              reviewsCount: true,
              status: true,
              deletedAt: true,
              images: { where: { isCover: true }, take: 1 },
            },
          },
        },
      }),
      this.prisma.favorite.count({ where: { userId: actor.id } }),
    ]);

    // Фильтруем объявления, которые перестали быть PUBLISHED
    // (хост снял с публикации, удалил и т.д.).
    // Оставляем запись в Favorite, но не показываем в списке.
    const visible = items.filter(
      (f) =>
        f.property &&
        f.property.status === 'PUBLISHED' &&
        !f.property.deletedAt,
    );

    return {
      items: visible,
      total, // общее количество избранного (включая скрытые)
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  }

  // ============================================================
  // 4. ПРОВЕРКА: В ИЗБРАННОМ ЛИ
  // ============================================================

  /**
   * Возвращает { isFavorite: boolean } для «сердечка» на карточке.
   * Лёгкий запрос — только existence check.
   */
  async check(propertyId: string, actor: Actor) {
    const favorite = await this.prisma.favorite.findUnique({
      where: {
        userId_propertyId: { userId: actor.id, propertyId },
      },
      select: { userId: true },
    });
    return { isFavorite: !!favorite };
  }
}
