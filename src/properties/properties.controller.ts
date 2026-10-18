import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Session, Roles, AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { PropertiesService } from './properties.service.js';
import { CreatePropertyDto } from './dto/create-property.dto.js';
import { UpdatePropertyDto } from './dto/update-property.dto.js';
import { QueryPropertiesDto } from './dto/query-properties.dto.js';
import { RejectPropertyDto } from './dto/reject-property.dto.js';
import { toActor } from '../common/auth/actor.js';

@Controller('properties')
export class PropertiesController {
  constructor(private readonly service: PropertiesService) {}

  // ============================================================
  // ПУБЛИЧНЫЕ ЭНДПОИНТЫ
  // ============================================================

  /**
   * Список опубликованных объявлений с фильтрами и курсорной пагинацией.
   * Доступен анонимно.
   */
  @Get()
  @AllowAnonymous()
  findPublic(@Query() query: QueryPropertiesDto) {
    return this.service.findPublic(query);
  }

  /**
   * Карточка объявления по id или slug.
   * Анонимно видит только PUBLISHED; владелец — свои любые;
   * админ — любые (кроме архивированных, см. PropertyPolicy.canView).
   *
   * ВАЖНО: @Session() в @thallesp/nestjs-better-auth может быть undefined
   * для анонимных запросов. Если ваша версия бросает исключение —
   * замените параметр на @Session() session: UserSession | undefined
   * и оберните в try/catch, либо вынесите публичный эндпоинт отдельно.
   */
  @Get(':idOrSlug')
  @AllowAnonymous()
  findOne(
    @Param('idOrSlug') idOrSlug: string,
    @Session() session?: UserSession,
  ) {
    const actor = session?.user ? toActor(session.user) : undefined;
    return this.service.findOne(idOrSlug, actor);
  }

  // ============================================================
  // МОИ ОБЪЯВЛЕНИЯ (ХОСТ)
  // ============================================================

  /**
   * Все объявления текущего хоста (все статусы, кроме архивированных).
   */
  @Get('my')
  @Roles(['HOST', 'ADMIN'])
  findMy(@Session() session: UserSession) {
    return this.service.findMy(toActor(session.user));
  }

  // ============================================================
  // CRUD
  // ============================================================

  /**
   * Создание объявления. Статус — DRAFT.
   * slug генерируется на бэкенде из title (см. PropertiesService.create).
   */
  @Post()
  @Roles(['HOST', 'ADMIN'])
  create(@Body() dto: CreatePropertyDto, @Session() session: UserSession) {
    return this.service.create(dto, toActor(session.user));
  }

  /**
   * Частичное обновление. Только владелец или админ.
   * Запрещено в PENDING_REVIEW и ARCHIVED (см. PropertyPolicy.assertCanEdit).
   */
  @Patch(':id')
  @Roles(['HOST', 'ADMIN'])
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePropertyDto,
    @Session() session: UserSession,
  ) {
    return this.service.update(id, dto, toActor(session.user));
  }

  /**
   * Мягкое удаление (архивация). Возвращает 204 No Content.
   * Нельзя архивировать при активных бронированиях (PENDING/CONFIRMED).
   */
  @Delete(':id')
  @Roles(['HOST', 'ADMIN'])
  @HttpCode(HttpStatus.NO_CONTENT)
  async archive(@Param('id') id: string, @Session() session: UserSession) {
    await this.service.archive(id, toActor(session.user));
  }

  // ============================================================
  // СТАТУСНЫЕ ПЕРЕХОДЫ
  // ============================================================

  /**
   * Отправка на модерацию: DRAFT/REJECTED → PENDING_REVIEW.
   * Только владелец. Требует хотя бы одно изображение.
   */
  @Post(':id/submit')
  @Roles(['HOST', 'ADMIN'])
  @HttpCode(HttpStatus.OK)
  submit(@Param('id') id: string, @Session() session: UserSession) {
    return this.service.submitForReview(id, toActor(session.user));
  }

  /**
   * Публикация: PENDING_REVIEW → PUBLISHED.
   * Только админ.
   */
  @Post(':id/publish')
  @Roles(['ADMIN'])
  @HttpCode(HttpStatus.OK)
  publish(@Param('id') id: string, @Session() session: UserSession) {
    return this.service.publish(id, toActor(session.user));
  }

  /**
   * Отклонение: PENDING_REVIEW → REJECTED, с обязательной причиной.
   * Только админ.
   */
  @Post(':id/reject')
  @Roles(['ADMIN'])
  @HttpCode(HttpStatus.OK)
  reject(
    @Param('id') id: string,
    @Body() dto: RejectPropertyDto,
    @Session() session: UserSession,
  ) {
    return this.service.reject(id, dto.reason, toActor(session.user));
  }

  /**
   * Пауза: PUBLISHED → PAUSED. Только владелец или админ.
   */
  @Post(':id/pause')
  @Roles(['HOST', 'ADMIN'])
  @HttpCode(HttpStatus.OK)
  pause(@Param('id') id: string, @Session() session: UserSession) {
    return this.service.pause(id, toActor(session.user));
  }

  /**
   * Возобновление: PAUSED → PUBLISHED. Только владелец или админ.
   */
  @Post(':id/resume')
  @Roles(['HOST', 'ADMIN'])
  @HttpCode(HttpStatus.OK)
  resume(@Param('id') id: string, @Session() session: UserSession) {
    return this.service.resume(id, toActor(session.user));
  }
}
