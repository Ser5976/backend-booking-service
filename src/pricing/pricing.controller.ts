import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { AllowAnonymous, Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { PricingService } from './pricing.service.js';
import { CreatePricingRuleDto } from './dto/create-pricing-rule.dto.js';
import { UpdatePricingRuleDto } from './dto/update-pricing-rule.dto.js';
import { toActor } from '../common/auth/actor.js';

@Controller('properties/:propertyId/pricing-rules')
export class PricingController {
  constructor(private readonly service: PricingService) {}

  /** Публичный список активных правил (для отображения на карточке) */
  @Get()
  @AllowAnonymous()
  list(@Param('propertyId') propertyId: string) {
    return this.service.listRules(propertyId);
  }

  @Post()
  @Roles(['HOST', 'ADMIN'])
  create(
    @Param('propertyId') propertyId: string,
    @Body() dto: CreatePricingRuleDto,
    @Session() session: UserSession,
  ) {
    return this.service.createRule(propertyId, dto, toActor(session.user));
  }

  @Patch(':ruleId')
  @Roles(['HOST', 'ADMIN'])
  update(
    @Param('ruleId') ruleId: string,
    @Body() dto: UpdatePricingRuleDto,
    @Session() session: UserSession,
  ) {
    return this.service.updateRule(ruleId, dto, toActor(session.user));
  }

  @Delete(':ruleId')
  @Roles(['HOST', 'ADMIN'])
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('ruleId') ruleId: string,
    @Session() session: UserSession,
  ) {
    await this.service.deleteRule(ruleId, toActor(session.user));
  }
}
