import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreatePricingRuleDto } from './dto/create-pricing-rule.dto.js';
import { UpdatePricingRuleDto } from './dto/update-pricing-rule.dto.js';
import { Actor } from '../common/auth/actor.js';
import {
  PricingRule,
  PricingRuleType,
  UserRole,
} from '../generated/prisma/client.js';

const MS_PER_DAY = 1000 * 60 * 60 * 24;
const LAST_MINUTE_DEFAULT_DAYS = 3;
const SERVICE_FEE_RATE = 0.1;

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  // ============================================================
  // RESOLVE NIGHT PRICE — цена за одну ночь
  // ============================================================

  /**
   * Цена за одну ночь (dateKey — 'yyyy-mm-dd').
   * Порядок: priceOverride → PricingRule (по priority) → basePrice.
   */
  async resolveNightPrice(
    propertyId: string,
    dateKey: string,
    basePrice: number,
  ): Promise<number> {
    const date = this.parseDate(dateKey);
    const override = await this.prisma.availability.findUnique({
      where: { propertyId_date: { propertyId, date } },
      select: { priceOverride: true },
    });
    if (override?.priceOverride != null) {
      return override.priceOverride;
    }

    const rule = await this.findApplicableRule(propertyId, dateKey);
    if (rule) {
      if (rule.fixedPrice != null) return rule.fixedPrice;
      if (rule.multiplier != null) {
        return Math.round(basePrice * rule.multiplier);
      }
    }

    return basePrice;
  }

  private async findApplicableRule(
    propertyId: string,
    dateKey: string,
  ): Promise<PricingRule | null> {
    const rules = await this.prisma.pricingRule.findMany({
      where: { propertyId, isActive: true },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });

    const dayOfWeek = this.getUTCDayOfWeek(dateKey);

    for (const rule of rules) {
      if (this.ruleMatchesDay(rule, dateKey, dayOfWeek)) {
        return rule;
      }
    }
    return null;
  }

  private ruleMatchesDay(
    rule: PricingRule,
    dateKey: string,
    dayOfWeek: number,
  ): boolean {
    switch (rule.type) {
      case PricingRuleType.SEASONAL:
      case PricingRuleType.HOLIDAY: {
        if (!rule.startDate || !rule.endDate) return false;
        const d = this.toDateKey(this.parseDate(dateKey));
        const start = this.toDateKey(rule.startDate);
        const end = this.toDateKey(rule.endDate);
        return d >= start && d <= end;
      }
      case PricingRuleType.WEEKEND:
        return rule.daysOfWeek.includes(dayOfWeek);
      case PricingRuleType.CUSTOM:
        return true;
      case PricingRuleType.LAST_MINUTE:
        return this.isLastMinute(dateKey, rule.minNights);
      case PricingRuleType.LONG_STAY:
        return false;
      default:
        return false;
    }
  }

  private isLastMinute(dateKey: string, withinDays?: number | null): boolean {
    const today = this.toDateKey(new Date());
    if (dateKey < today) return false;
    const diffDays = Math.round(
      (this.parseDate(dateKey).getTime() - this.parseDate(today).getTime()) /
        MS_PER_DAY,
    );
    return diffDays <= (withinDays ?? LAST_MINUTE_DEFAULT_DAYS);
  }

  // ============================================================
  // CALCULATE PRICE — полный расчёт для брони
  // ============================================================

  /**
   * Полный расчёт стоимости проживания.
   * Учитывает priceOverride, PricingRule, LONG_STAY-скидку,
   * minNightsOverride из Availability.
   */
  async calculatePrice(params: {
    propertyId: string;
    checkIn: string;
    checkOut: string;
    guests: number;
  }): Promise<{
    nights: number;
    pricePerNight: number;
    nightsTotal: number;
    cleaningFee: number;
    serviceFee: number;
    taxes: number;
    discount: number;
    totalAmount: number;
    hostPayoutAmount: number;
    breakdown: Array<{ date: string; price: number }>;
  }> {
    const { propertyId, checkIn, checkOut } = params;

    if (checkIn >= checkOut) {
      throw new BadRequestException('checkOut должен быть позже checkIn');
    }

    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      select: {
        id: true,
        basePricePerNight: true,
        cleaningFee: true,
        minNights: true,
        maxNights: true,
        deletedAt: true,
        status: true,
      },
    });
    if (!property || property.deletedAt) {
      throw new NotFoundException('Объявление не найдено');
    }

    const nights = this.diffDays(checkIn, checkOut);

    // minNights: max(property.minNights, minNightsOverride по ночам)
    const minNightsRequired = await this.resolveMinNights(
      propertyId,
      checkIn,
      checkOut,
      property.minNights,
    );
    if (nights < minNightsRequired) {
      throw new BadRequestException(`Минимум ${minNightsRequired} ночей`);
    }
    if (nights > property.maxNights) {
      throw new BadRequestException(`Максимум ${property.maxNights} ночей`);
    }

    // 1. Цена за каждую ночь (checkOut не входит)
    const breakdown: Array<{ date: string; price: number }> = [];
    let nightsTotal = 0;
    for (const dateKey of this.eachDate(checkIn, checkOut)) {
      const price = await this.resolveNightPrice(
        propertyId,
        dateKey,
        property.basePricePerNight,
      );
      breakdown.push({ date: dateKey, price });
      nightsTotal += price;
    }

    // 2. LONG_STAY-скидка
    const discount = await this.calculateLongStayDiscount(
      propertyId,
      nights,
      nightsTotal,
    );

    // 3. Комиссия платформы
    const subtotal = nightsTotal - discount + property.cleaningFee;
    const serviceFee = Math.round(subtotal * SERVICE_FEE_RATE);

    // 4. Налоги (заглушка)
    const taxes = 0;

    // 5. Итого
    const totalAmount =
      nightsTotal - discount + property.cleaningFee + serviceFee + taxes;
    const hostPayoutAmount = nightsTotal - discount + property.cleaningFee;

    return {
      nights,
      pricePerNight: Math.round(nightsTotal / nights),
      nightsTotal,
      cleaningFee: property.cleaningFee,
      serviceFee,
      taxes,
      discount,
      totalAmount,
      hostPayoutAmount,
      breakdown,
    };
  }

  /**
   * Максимальный minNights по всем ночам [checkIn, checkOut).
   * Учитывает property.minNights и Availability.minNightsOverride.
   */
  private async resolveMinNights(
    propertyId: string,
    checkIn: string,
    checkOut: string,
    defaultMinNights: number,
  ): Promise<number> {
    const overrides = await this.prisma.availability.findMany({
      where: {
        propertyId,
        date: {
          gte: this.parseDate(checkIn),
          lt: this.parseDate(checkOut),
        },
        minNightsOverride: { not: null },
      },
      select: { minNightsOverride: true },
    });

    let max = defaultMinNights;
    for (const o of overrides) {
      if (o.minNightsOverride != null && o.minNightsOverride > max) {
        max = o.minNightsOverride;
      }
    }
    return max;
  }

  private async calculateLongStayDiscount(
    propertyId: string,
    nights: number,
    nightsTotal: number,
  ): Promise<number> {
    const rules = await this.prisma.pricingRule.findMany({
      where: {
        propertyId,
        isActive: true,
        type: PricingRuleType.LONG_STAY,
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });

    for (const rule of rules) {
      if (rule.minNights != null && nights >= rule.minNights) {
        if (rule.multiplier != null && rule.multiplier < 1) {
          return Math.round(nightsTotal * (1 - rule.multiplier));
        }
        if (rule.fixedPrice != null) {
          return Math.min(rule.fixedPrice, nightsTotal);
        }
      }
    }
    return 0;
  }

  // ============================================================
  // CRUD ДЛЯ ПРАВИЛ (хост)
  // ============================================================

  async listRules(propertyId: string) {
    return this.prisma.pricingRule.findMany({
      where: { propertyId },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  async createRule(
    propertyId: string,
    dto: CreatePricingRuleDto,
    actor: Actor,
  ) {
    await this.getPropertyForWrite(propertyId, actor);
    this.validateRuleShape(dto);

    return this.prisma.pricingRule.create({
      data: {
        propertyId,
        name: dto.name,
        type: dto.type,
        startDate: dto.startDate ? this.parseDate(dto.startDate) : null,
        endDate: dto.endDate ? this.parseDate(dto.endDate) : null,
        daysOfWeek: dto.daysOfWeek ?? [],
        minNights: dto.minNights,
        multiplier: dto.multiplier,
        fixedPrice: dto.fixedPrice,
        priority: dto.priority ?? 0,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async updateRule(ruleId: string, dto: UpdatePricingRuleDto, actor: Actor) {
    const rule = await this.prisma.pricingRule.findUnique({
      where: { id: ruleId },
      include: { property: { select: { hostId: true, deletedAt: true } } },
    });
    if (!rule) throw new NotFoundException('Правило не найдено');
    if (rule.property.hostId !== actor.id && actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Нельзя менять чужое правило');
    }
    if (rule.property.deletedAt) {
      throw new BadRequestException('Объявление удалено');
    }

    const merged: CreatePricingRuleDto = {
      name: dto.name ?? rule.name,
      type: dto.type ?? rule.type,
      startDate: dto.startDate ?? rule.startDate?.toISOString().slice(0, 10),
      endDate: dto.endDate ?? rule.endDate?.toISOString().slice(0, 10),
      daysOfWeek: dto.daysOfWeek ?? rule.daysOfWeek,
      minNights: dto.minNights ?? rule.minNights ?? undefined,
      multiplier: dto.multiplier ?? rule.multiplier ?? undefined,
      fixedPrice: dto.fixedPrice ?? rule.fixedPrice ?? undefined,
      priority: dto.priority ?? rule.priority,
      isActive: dto.isActive ?? rule.isActive,
    };
    this.validateRuleShape(merged);

    return this.prisma.pricingRule.update({
      where: { id: ruleId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.type !== undefined && { type: dto.type }),
        ...(dto.startDate !== undefined && {
          startDate: dto.startDate ? this.parseDate(dto.startDate) : null,
        }),
        ...(dto.endDate !== undefined && {
          endDate: dto.endDate ? this.parseDate(dto.endDate) : null,
        }),
        ...(dto.daysOfWeek !== undefined && { daysOfWeek: dto.daysOfWeek }),
        ...(dto.minNights !== undefined && { minNights: dto.minNights }),
        ...(dto.multiplier !== undefined && { multiplier: dto.multiplier }),
        ...(dto.fixedPrice !== undefined && { fixedPrice: dto.fixedPrice }),
        ...(dto.priority !== undefined && { priority: dto.priority }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
  }

  async deleteRule(ruleId: string, actor: Actor) {
    const rule = await this.prisma.pricingRule.findUnique({
      where: { id: ruleId },
      include: { property: { select: { hostId: true, deletedAt: true } } },
    });
    if (!rule) throw new NotFoundException('Правило не найдено');
    if (rule.property.hostId !== actor.id && actor.role !== UserRole.ADMIN) {
      throw new ForbiddenException('Нельзя удалять чужое правило');
    }
    await this.prisma.pricingRule.delete({ where: { id: ruleId } });
    return { ok: true };
  }

  // ============================================================
  // ХЕЛПЕРЫ
  // ============================================================

  private async getPropertyForWrite(propertyId: string, actor: Actor) {
    const property = await this.prisma.property.findUnique({
      where: { id: propertyId },
      select: { id: true, hostId: true, deletedAt: true },
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

  private validateRuleShape(dto: CreatePricingRuleDto) {
    if (
      dto.type === PricingRuleType.SEASONAL ||
      dto.type === PricingRuleType.HOLIDAY
    ) {
      if (!dto.startDate || !dto.endDate) {
        throw new BadRequestException(`${dto.type}: нужны startDate и endDate`);
      }
      if (dto.startDate > dto.endDate) {
        throw new BadRequestException('startDate позже endDate');
      }
    }
    if (
      dto.type === PricingRuleType.WEEKEND &&
      (!dto.daysOfWeek || dto.daysOfWeek.length === 0)
    ) {
      throw new BadRequestException('WEEKEND: нужен daysOfWeek');
    }
    if (dto.multiplier == null && dto.fixedPrice == null) {
      throw new BadRequestException('Нужен multiplier или fixedPrice');
    }
  }

  private parseDate(key: string): Date {
    return new Date(`${key}T00:00:00.000Z`);
  }

  private toDateKey(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private diffDays(from: string, to: string): number {
    return Math.round(
      (this.parseDate(to).getTime() - this.parseDate(from).getTime()) /
        MS_PER_DAY,
    );
  }

  private getUTCDayOfWeek(dateKey: string): number {
    return this.parseDate(dateKey).getUTCDay();
  }

  private *eachDate(from: string, to: string): Generator<string> {
    let cur = this.parseDate(from);
    const end = this.parseDate(to);
    while (cur < end) {
      yield this.toDateKey(cur);
      const next = new Date(cur);
      next.setUTCDate(next.getUTCDate() + 1);
      cur = next;
    }
  }
}
