import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Session, Roles, AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { ImagesService } from './images.service.js';
import { ImageKitService } from '../imagekit/imagekit.service.js';
import { AttachImageDto } from './dto/attach-image.dto.js';
import { ReorderImagesDto } from './dto/reorder-images.dto.js';
import { toActor } from '../common/auth/actor.js';

@Controller()
export class ImagesController {
  constructor(
    private readonly service: ImagesService,
    private readonly imageKit: ImageKitService,
  ) {}

  // ============================================================
  // AUTH-ПАРАМЕТРЫ ДЛЯ ПРЯМОЙ ЗАГРУЗКИ
  // ============================================================

  /**
   * Клиент получает { token, expire, signature } и грузит файл
   * напрямую в ImageKit. privateKey не покидает сервер.
   */
  @Get('images/upload-auth')
  @Roles(['HOST', 'ADMIN'])
  getUploadAuth() {
    return this.imageKit.getAuthenticationParameters();
  }

  // ============================================================
  // ПРИВЯЗКА / СПИСОК / ПОРЯДОК / УДАЛЕНИЕ
  // ============================================================

  @Post('properties/:propertyId/images')
  @Roles(['HOST', 'ADMIN'])
  attach(
    @Param('propertyId') propertyId: string,
    @Body() dto: AttachImageDto,
    @Session() session: UserSession,
  ) {
    // Гарантируем, что propertyId из URL совпадает с телом
    if (dto.propertyId !== propertyId) {
      dto.propertyId = propertyId;
    }
    return this.service.attach(dto, toActor(session.user));
  }

  @Get('properties/:propertyId/images')
  @AllowAnonymous()
  list(@Param('propertyId') propertyId: string) {
    return this.service.listByProperty(propertyId);
  }

  @Patch('properties/:propertyId/images/reorder')
  @Roles(['HOST', 'ADMIN'])
  reorder(
    @Param('propertyId') propertyId: string,
    @Body() dto: ReorderImagesDto,
    @Session() session: UserSession,
  ) {
    if (dto.propertyId !== propertyId) dto.propertyId = propertyId;
    return this.service.reorder(dto, toActor(session.user));
  }

  @Delete('images/:imageId')
  @Roles(['HOST', 'ADMIN'])
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('imageId') imageId: string,
    @Session() session: UserSession,
  ) {
    await this.service.remove(imageId, toActor(session.user));
  }
}
