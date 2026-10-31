import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { QueryAvailabilityDto } from './dto/query-availability.dto.js';
import { UpdateAvailabilityDto } from './dto/update-availability.dto.js';
import { Actor } from '../common/auth/actor.js';
import { PropertyStatus, UserRole } from '../generated/prisma/client.js';

const DEFAULT_RANGE_DAYS = 90;
const MAX_RANGE_DAYS = 365;
const MS_PER_DAY = 1000 * 60 * 60 * 24;

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: PricingService,
  ) {}

  // ============================================================
  // ПУБЛИЧНОЕ ЧТЕНИЕ КАЛЕНДАРЯ
  // ============================================================

  /**
   * Календарь дней [from, to] включительно.
   * isAvailable = override.isAvailable (если задан) И отсутствие брони/override-false.
   * price = override.priceOverride ИЛИ PricingService.
   */
  async getCalendar(propertyId: string, query: QueryAvailabilityDto) {
    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      select: {
        id: true,
        status: true,
        deletedAt: true,
        basePricePerNight: true,
        minNights: true,
      },
    });

    if (!property || property.deletedAt) {
      throw new NotFoundException('Объявление не найдено');
    }
    if (property.status !== PropertyStatus.PUBLISHED) {
      throw new NotFoundException('Объявление не найдено');
    }

    const { from, to } = this.resolveRange(query);

    // 1. Оверрайды
    const overrides = await this.prisma.availability.findMany({
      where: {
        propertyId,
        date: { gte: this.parseDate(from), lte: this.parseDate(to) },
      },
    });
    const overrideByDate = new Map(
      overrides.map((o) => [this.toDateKey(o.date), o]),
    );

    // 2. Недоступные дни (брони + ручные блокировки)
    const unavailable = await this.findUnavailableDatesInRange(
      propertyId,
      from,
      to,
    );

    // 3. Сборка ответа
    const days: Array<{
      date: string;
      isAvailable: boolean;
      price: number;
      minNights: number;
      note: string | null;
    }> = [];

    for (const dateKey of this.eachDayInclusive(from, to)) {
      const override = overrideByDate.get(dateKey);
      const isUnavailable = unavailable.has(dateKey);

      const price =
        override?.priceOverride ??
        (await this.pricing.resolveNightPrice(
          propertyId,
          dateKey,
          property.basePricePerNight,
        ));

      const isAvailable = override
        ? override.isAvailable && !isUnavailable
        : !isUnavailable;

      days.push({
        date: dateKey,
        isAvailable,
        price,
        minNights: override?.minNightsOverride ?? property.minNights,
        note: override?.note ?? null,
      });
    }

    return { propertyId, days };
  }

  // ============================================================
  // ОБНОВЛЕНИЕ (ХОСТ / АДМИН)
  // ============================================================

  async update(propertyId: string, dto: UpdateAvailabilityDto, actor: Actor) {
    await this.getPropertyForWrite(propertyId, actor);

    const dateKeys = [...new Set(dto.dates)].sort();
    this.assertValidDates(dateKeys);

    // Проверка конфликтов с активными бронями и ручными блокировками
    // (findUnavailableDatesInRange включает только брони и isAvailable:false;
    // для update нам нужны только брони — блокировки перезаписывать можно)
    const booked = await this.findBookedDatesInRange(
      propertyId,
      dateKeys[0]!,
      dateKeys[dateKeys.length - 1]!,
    );
    const conflicts = dateKeys.filter((d) => booked.has(d));
    if (conflicts.length > 0) {
      throw new ConflictException(
        `Нельзя менять даты с активными бронями: ${conflicts.join(', ')}`,
      );
    }

    const operations = dateKeys.map((dateKey) => {
      const date = this.parseDate(dateKey);

      const updateData: {
        isAvailable?: boolean;
        priceOverride?: number | null;
        minNightsOverride?: number | null;
      } = {};

      if (dto.isAvailable !== undefined) {
        updateData.isAvailable = dto.isAvailable;
      }
      if (dto.isNullPrice) {
        updateData.priceOverride = null;
      } else if (dto.priceOverride !== undefined) {
        updateData.priceOverride = dto.priceOverride;
      }
      if (dto.isNullMinNights) {
        updateData.minNightsOverride = null;
      } else if (dto.minNightsOverride !== undefined) {
        updateData.minNightsOverride = dto.minNightsOverride;
      }

      const createData = {
        propertyId,
        date,
        isAvailable: dto.isAvailable ?? true,
        priceOverride: dto.isNullPrice ? null : (dto.priceOverride ?? null),
        minNightsOverride: dto.isNullMinNights
          ? null
          : (dto.minNightsOverride ?? null),
      };

      return this.prisma.availability.upsert({
        where: { propertyId_date: { propertyId, date } },
        create: createData,
        update: updateData,
      });
    });

    await this.prisma.$transaction(operations);

    return { updated: dateKeys.length, dates: dateKeys };
  }

  // ============================================================
  // ПУБЛИЧНЫЕ ХЕЛПЕРЫ ДЛЯ BOOKINGS
  // ============================================================

  /**
   * Множество НЕДОСТУПНЫХ дат (yyyy-mm-dd) в [from, to].
   * Включает активные брони (PENDING/CONFIRMED) и isAvailable:false.
   * checkIn входит, checkOut — нет.
   */
  async findUnavailableDatesInRange(
    propertyId: string,
    from: string,
    to: string,
  ): Promise<Set<string>> {
    const result = new Set<string>();

    // 1. Активные брони
    const bookings = await this.prisma.booking.findMany({
      where: {
        propertyId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        checkIn: { lt: this.parseDate(to) },
        checkOut: { gt: this.parseDate(from) },
      },
      select: { checkIn: true, checkOut: true },
    });
    for (const b of bookings) {
      for (const d of this.eachDate(b.checkIn, b.checkOut)) {
        result.add(d);
      }
    }

    // 2. Ручные блокировки
    const blocked = await this.prisma.availability.findMany({
      where: {
        propertyId,
        isAvailable: false,
        date: { gte: this.parseDate(from), lt: this.parseDate(to) },
      },
      select: { date: true },
    });
    for (const b of blocked) {
      result.add(this.toDateKey(b.date));
    }

    return result;
  }

  /**
   * Множество ТОЛЬКО занятых бронями дат (yyyy-mm-dd) в [from, to].
   * Используется в update (закрывать вручную заблокированные дни можно повторно).
   */
  private async findBookedDatesInRange(
    propertyId: string,
    from: string,
    to: string,
  ): Promise<Set<string>> {
    const bookings = await this.prisma.booking.findMany({
      where: {
        propertyId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        checkIn: { lt: this.parseDate(to) },
        checkOut: { gt: this.parseDate(from) },
      },
      select: { checkIn: true, checkOut: true },
    });

    const result = new Set<string>();
    for (const b of bookings) {
      for (const d of this.eachDate(b.checkIn, b.checkOut)) {
        result.add(d);
      }
    }
    return result;
  }

  // ============================================================
  // ХЕЛПЕРЫ
  // ============================================================

  private async getPropertyForWrite(propertyId: string, actor: Actor) {
    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, hostId: true, status: true, deletedAt: true },
    });
    if (!property) throw new NotFoundException('Объявление не найдено');
    if (property.hostId !== actor.id && actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Нельзя менять чужое объявление');
    }
    if (property.deletedAt) {
      throw new BadRequestException('Объявление удалено');
    }
    return property;
  }

  private assertValidDates(dateKeys: string[]) {
    if (dateKeys.length === 0) {
      throw new BadRequestException('Не передано ни одной даты');
    }
    for (const d of dateKeys) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) {
        throw new BadRequestException(`Неверный формат даты: ${d}`);
      }
    }
    const today = this.toDateKey(new Date());
    for (const d of dateKeys) {
      if (d < today) {
        throw new BadRequestException(`Нельзя менять прошедшие даты: ${d}`);
      }
    }
  }

  private resolveRange(query: QueryAvailabilityDto): {
    from: string;
    to: string;
  } {
    const today = this.toDateKey(new Date());
    const from = query.from ?? today;
    const to =
      query.to ??
      this.toDateKey(this.addDays(this.parseDate(from), DEFAULT_RANGE_DAYS));

    const fromDate = this.parseDate(from);
    const toDate = this.parseDate(to);

    if (toDate < fromDate) {
      throw new BadRequestException('to не может быть раньше from');
    }

    const span = Math.round(
      (toDate.getTime() - fromDate.getTime()) / MS_PER_DAY,
    );
    if (span > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `Диапазон не может превышать ${MAX_RANGE_DAYS} дней`,
      );
    }

    return { from, to };
  }

  private parseDate(key: string): Date {
    return new Date(`${key}T00:00:00.000Z`);
  }

  private toDateKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private addDays(d: Date, days: number): Date {
    const copy = new Date(d);
    copy.setUTCDate(copy.getUTCDate() + days);
    return copy;
  }

  /** [from, to) — checkIn входит, checkOut нет */
  private *eachDate(from: Date | string, to: Date | string): Generator<string> {
    const start = typeof from === 'string' ? this.parseDate(from) : from;
    const end = typeof to === 'string' ? this.parseDate(to) : to;
    let cur = new Date(start);
    while (cur < end) {
      yield this.toDateKey(cur);
      cur = this.addDays(cur, 1);
    }
  }

  /** [from, to] — включает последний день (для календаря) */
  private *eachDayInclusive(
    from: Date | string,
    to: Date | string,
  ): Generator<string> {
    const start = typeof from === 'string' ? this.parseDate(from) : from;
    const end = typeof to === 'string' ? this.parseDate(to) : to;
    let cur = new Date(start);
    while (cur <= end) {
      yield this.toDateKey(cur);
      cur = this.addDays(cur, 1);
    }
  }
}
