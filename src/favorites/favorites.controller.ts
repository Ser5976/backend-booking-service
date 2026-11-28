import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Session, Roles } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { FavoritesService } from './favorites.service.js';
import { toActor } from '../common/auth/actor.js';

@Controller('favorites')
export class FavoritesController {
  constructor(private readonly service: FavoritesService) {}

  // ============================================================
  // СПИСОК
  // ============================================================

  /**
   * GET /favorites?limit=20&offset=0
   * Список избранных объявлений текущего пользователя.
   */
  @Get()
  @Roles(['GUEST', 'HOST', 'ADMIN'])
  list(
    @Session() session: UserSession,
    @Query('limit') limit?: number,
    @Query('offset') offset?: number,
  ) {
    return this.service.list(toActor(session.user), {
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  // ============================================================
  // ПРОВЕРКА
  // ============================================================

  /**
   * GET /favorites/check/:propertyId
   * Возвращает { isFavorite: boolean } — для «сердечка» на карточке.
   *
   * ВАЖНО: этот маршрут должен идти ДО @Get(':propertyId'),
   * иначе NestJS матчит 'check' как propertyId.
   */
  @Get('check/:propertyId')
  @Roles(['GUEST', 'HOST', 'ADMIN'])
  check(
    @Param('propertyId') propertyId: string,
    @Session() session: UserSession,
  ) {
    return this.service.check(propertyId, toActor(session.user));
  }

  // ============================================================
  // ДОБАВИТЬ / УБРАТЬ
  // ============================================================

  /**
   * POST /favorites/:propertyId
   * Добавить в избранное (идемпотентно).
   */
  @Post(':propertyId')
  @Roles(['GUEST', 'HOST', 'ADMIN'])
  @HttpCode(HttpStatus.OK)
  add(
    @Param('propertyId') propertyId: string,
    @Session() session: UserSession,
  ) {
    return this.service.add(propertyId, toActor(session.user));
  }

  /**
   * DELETE /favorites/:propertyId
   * Убрать из избранного (идемпотентно).
   */
  @Delete(':propertyId')
  @Roles(['GUEST', 'HOST', 'ADMIN'])
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('propertyId') propertyId: string,
    @Session() session: UserSession,
  ) {
    return this.service.remove(propertyId, toActor(session.user));
  }
}
