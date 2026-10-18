import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreatePropertyDto } from './dto/create-property.dto.js';
import { UpdatePropertyDto } from './dto/update-property.dto.js';
import { QueryPropertiesDto } from './dto/query-properties.dto.js';
import { PropertyPolicy } from './policies/property.policy.js';
import { PropertyStatus } from '../generated/prisma/client.js';
import { randomBytes } from 'crypto';
import { Actor } from '../common/auth/actor.js';

@Injectable()
export class PropertiesService {
  constructor(private readonly prisma: PrismaService) {}

  // ---------- Создание ----------

  async create(dto: CreatePropertyDto, actor: Actor) {
    if (actor.role !== 'HOST' && actor.role !== 'ADMIN') {
      throw new ConflictException('Только хост может создавать объявления');
    }

    const slug = await this.generateUniqueSlug(dto.title);

    return this.prisma.property.create({
      data: {
        hostId: actor.id,
        slug,
        status: PropertyStatus.DRAFT,
        // Обязательные поля из DTO
        title: dto.title,
        description: dto.description,
        type: dto.type,
        country: dto.country,
        city: dto.city,
        region: dto.region,
        street: dto.street,
        building: dto.building,
        apartment: dto.apartment,
        postalCode: dto.postalCode,
        latitude: dto.latitude,
        longitude: dto.longitude,
        maxGuests: dto.maxGuests,
        bedrooms: dto.bedrooms ?? 1,
        beds: dto.beds ?? 1,
        bathrooms: dto.bathrooms ?? 1,
        areaSqm: dto.areaSqm,
        minNights: dto.minNights ?? 1,
        maxNights: dto.maxNights ?? 365,
        checkInTime: dto.checkInTime ?? '15:00',
        checkOutTime: dto.checkOutTime ?? '11:00',
        instantBook: dto.instantBook ?? false,
        smokingAllowed: dto.smokingAllowed ?? false,
        petsAllowed: dto.petsAllowed ?? false,
        partiesAllowed: dto.partiesAllowed ?? false,
        basePricePerNight: dto.basePricePerNight,
        cleaningFee: dto.cleaningFee ?? 0,
        securityDeposit: dto.securityDeposit ?? 0,
        currency: dto.currency ?? 'USD',
      },
    });
  }

  // ---------- Чтение ----------

  async findPublic(query: QueryPropertiesDto) {
    const where: any = {
      status: PropertyStatus.PUBLISHED,
      deletedAt: null,
    };
    if (query.city) where.city = { equals: query.city, mode: 'insensitive' };
    if (query.country)
      where.country = { equals: query.country, mode: 'insensitive' };
    if (query.type) where.type = query.type;
    if (query.guests) where.maxGuests = { gte: query.guests };
    if (query.minPrice != null || query.maxPrice != null) {
      where.basePricePerNight = {};
      if (query.minPrice != null) where.basePricePerNight.gte = query.minPrice;
      if (query.maxPrice != null) where.basePricePerNight.lte = query.maxPrice;
    }

    const limit = query.limit ?? 20;
    const items = await this.prisma.property.findMany({
      where,
      take: limit + 1, // +1 чтобы понять, есть ли следующая страница
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      orderBy: this.buildOrderBy(query),
      include: {
        images: { where: { isCover: true }, take: 1 },
      },
    });

    const hasNext = items.length > limit;
    const page = hasNext ? items.slice(0, limit) : items;
    return {
      items: page,
      nextCursor: hasNext ? page[page.length - 1].id : null,
    };
  }

  async findOne(idOrSlug: string, actor?: Actor) {
    const property = await this.prisma.property.findFirst({
      where: {
        OR: [{ id: idOrSlug }, { slug: idOrSlug }],
      },
      include: {
        images: { orderBy: { order: 'asc' } },
        amenities: { include: { amenity: true } },
        host: {
          select: { id: true, name: true, image: true, createdAt: true },
        },
      },
    });
    if (!property) throw new NotFoundException('Объявление не найдено');
    if (!PropertyPolicy.canView(property, actor)) {
      throw new NotFoundException('Объявление не найдено'); // намеренно 404, а не 403 — не палим существование
    }
    return property;
  }

  async findMy(actor: Actor) {
    return this.prisma.property.findMany({
      where: { hostId: actor.id, deletedAt: null },
      orderBy: { createdAt: 'desc' },
      include: { images: { where: { isCover: true }, take: 1 } },
    });
  }

  // ---------- Обновление ----------

  async update(id: string, dto: UpdatePropertyDto, actor: Actor) {
    const property = await this.getOrThrow(id);
    PropertyPolicy.assertCanEdit(property, actor);

    // Запрет менять тип и валюту после публикации
    if (property.status === PropertyStatus.PUBLISHED) {
      if (dto.type && dto.type !== property.type) {
        throw new BadRequestException('Нельзя менять тип после публикации');
      }
      if (dto.currency && dto.currency !== property.currency) {
        throw new BadRequestException('Нельзя менять валюту после публикации');
      }
    }

    const data: any = { ...dto };
    // Не позволяем менять служебные поля через PATCH
    delete data.status;
    delete data.slug;
    delete data.hostId;

    return this.prisma.property.update({ where: { id }, data });
  }

  // ---------- Статусные переходы ----------

  async submitForReview(id: string, actor: Actor) {
    const property = await this.getOrThrow(id);
    PropertyPolicy.assertCanSubmit(property, actor);

    // Валидация «готовности к модерации»: хотя бы одно изображение
    const imageCount = await this.prisma.propertyImage.count({
      where: { propertyId: id },
    });
    if (imageCount === 0) {
      throw new BadRequestException(
        'Добавьте хотя бы одно изображение перед отправкой',
      );
    }

    return this.prisma.property.update({
      where: { id },
      data: { status: PropertyStatus.PENDING_REVIEW },
    });
  }

  async publish(id: string, actor: Actor) {
    PropertyPolicy.assertCanModerate(actor);
    const property = await this.getOrThrow(id);
    if (property.status !== PropertyStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        `Публикация возможна только из PENDING_REVIEW, сейчас ${property.status}`,
      );
    }
    return this.prisma.property.update({
      where: { id },
      data: {
        status: PropertyStatus.PUBLISHED,
        publishedAt: new Date(),
        rejectionReason: null,
      },
    });
  }

  async reject(id: string, reason: string, actor: Actor) {
    PropertyPolicy.assertCanModerate(actor);
    const property = await this.getOrThrow(id);
    if (property.status !== PropertyStatus.PENDING_REVIEW) {
      throw new BadRequestException(
        `Отклонение возможно только из PENDING_REVIEW, сейчас ${property.status}`,
      );
    }
    return this.prisma.property.update({
      where: { id },
      data: { status: PropertyStatus.REJECTED, rejectionReason: reason },
    });
  }

  async pause(id: string, actor: Actor) {
    const property = await this.getOrThrow(id);
    PropertyPolicy.assertCanPause(property, actor);
    return this.prisma.property.update({
      where: { id },
      data: { status: PropertyStatus.PAUSED },
    });
  }

  async resume(id: string, actor: Actor) {
    const property = await this.getOrThrow(id);
    if (property.hostId !== actor.id && actor.role !== 'ADMIN') {
      throw new ConflictException();
    }
    if (property.status !== PropertyStatus.PAUSED) {
      throw new BadRequestException(
        'Возобновить можно только приостановленное',
      );
    }
    return this.prisma.property.update({
      where: { id },
      data: { status: PropertyStatus.PUBLISHED },
    });
  }

  async archive(id: string, actor: Actor) {
    const property = await this.getOrThrow(id);
    PropertyPolicy.assertCanArchive(property, actor);

    // Нельзя архивировать, если есть активные брони
    const activeBookings = await this.prisma.booking.count({
      where: {
        propertyId: id,
        status: { in: ['PENDING', 'CONFIRMED'] },
      },
    });
    if (activeBookings > 0) {
      throw new ConflictException(
        'Нельзя архивировать: есть активные бронирования',
      );
    }

    return this.prisma.property.update({
      where: { id },
      data: { status: PropertyStatus.ARCHIVED, deletedAt: new Date() },
    });
  }

  // ---------- Вспомогательные ----------

  private async getOrThrow(id: string) {
    const property = await this.prisma.property.findUnique({ where: { id } });
    if (!property) throw new NotFoundException('Объявление не найдено');
    return property;
  }

  private buildOrderBy(query: QueryPropertiesDto) {
    const field = query.sortBy ?? 'createdAt';
    const order = query.sortOrder ?? 'desc';
    // Для стабильной пагинации при равных значениях добавляем id
    return [{ [field]: order }, { id: order }];
  }

  private async generateUniqueSlug(title: string): Promise<string> {
    const base =
      title
        .toLowerCase()
        .replace(/[^a-z0-9а-яё]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'property';

    for (let i = 0; i < 5; i++) {
      const candidate =
        i === 0 ? base : `${base}-${randomBytes(3).toString('hex')}`;
      const exists = await this.prisma.property.findUnique({
        where: { slug: candidate },
      });
      if (!exists) return candidate;
    }
    // Крайний случай — гарантированно уникальный
    return `${base}-${randomBytes(8).toString('hex')}`;
  }
}
