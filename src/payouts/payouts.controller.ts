import { Controller, Get, Post, Param, Query, Body } from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { PayoutsService } from './payouts.service.js';
import { toActor } from '../common/auth/actor.js';
import { PayoutStatus } from '../generated/prisma/client.js';

@Controller('payouts')
export class PayoutsController {
  constructor(private readonly service: PayoutsService) {}

  // ============================================================
  // ХОСТ — СВОИ ВЫПЛАТЫ
  // ============================================================

  /**
   * GET /payouts/my — список выплат текущего хоста.
   * Хост видит свои PENDING / PAID / FAILED.
   */
  @Get('my')
  @Roles(['HOST', 'ADMIN'])
  findMy(@Session() session: UserSession) {
    return this.service.findMy(toActor(session.user));
  }

  // ============================================================
  // АДМИН — ВСЕ ВЫПЛАТЫ
  // ============================================================

  /**
   * GET /payouts?status=PENDING&hostId=...&limit=20&offset=0
   * Список всех выплат с фильтрами (только админ).
   */
  @Get()
  @Roles(['ADMIN'])
  findAll(
    @Query('status') status?: PayoutStatus,
    @Query('hostId') hostId?: string,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.service.findAll({
      status,
      hostId,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  // ============================================================
  // АДМИН — ОТМЕТИТЬ ВЫПЛАТУ
  // ============================================================

  /**
   * POST /payouts/:id/mark-paid
   * Админ отмечает Payout как PAID после ручного перевода.
   * Опционально — stripeTransferId (если переводил через Stripe вручную).
   */
  @Post(':id/mark-paid')
  @Roles(['ADMIN'])
  markPaid(
    @Param('id') payoutId: string,
    @Body() body: { stripeTransferId?: string },
    @Session() session: UserSession,
  ) {
    return this.service.markPaid(
      payoutId,
      toActor(session.user),
      body?.stripeTransferId,
    );
  }

  /**
   * POST /payouts/:id/mark-failed
   * Админ отмечает Payout как FAILED с причиной.
   */
  @Post(':id/mark-failed')
  @Roles(['ADMIN'])
  markFailed(
    @Param('id') payoutId: string,
    @Body() body: { reason: string },
    @Session() session: UserSession,
  ) {
    return this.service.markFailed(
      payoutId,
      body.reason,
      toActor(session.user),
    );
  }
}
