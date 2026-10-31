import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { AllowAnonymous, Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { AvailabilityService } from './availability.service.js';
import { QueryAvailabilityDto } from './dto/query-availability.dto.js';
import { UpdateAvailabilityDto } from './dto/update-availability.dto.js';
import { toActor } from '../common/auth/actor.js';

@Controller('properties/:propertyId/availability')
export class AvailabilityController {
  constructor(private readonly service: AvailabilityService) {}

  /**
   * Публичный календарь: свободные дни и цены.
   * GET /properties/:propertyId/availability?from=2025-01-01&to=2025-03-31
   */
  @Get()
  @AllowAnonymous()
  getCalendar(
    @Param('propertyId') propertyId: string,
    @Query() query: QueryAvailabilityDto,
  ) {
    return this.service.getCalendar(propertyId, query);
  }

  /**
   * Хост блокирует/открывает дни или ставит override-цену.
   * PATCH /properties/:propertyId/availability
   */
  @Patch()
  @Roles(['HOST', 'ADMIN'])
  update(
    @Param('propertyId') propertyId: string,
    @Body() dto: UpdateAvailabilityDto,
    @Session() session: UserSession,
  ) {
    return this.service.update(propertyId, dto, toActor(session.user));
  }
}
