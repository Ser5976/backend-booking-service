import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
} from '@nestjs/common';
import { AllowAnonymous, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { UsersService } from './users.service.js';
import { UpdateUserDto } from './dto/update-user.dto.js';
import { DeleteAccountDto } from './dto/delete-account.dto.js';

@Controller('users')
export class UsersController {
  constructor(private readonly service: UsersService) {}

  /**
   * GET /users/me — полный профиль текущего пользователя.
   */
  @Get('me')
  findMe(@Session() session: UserSession) {
    return this.service.findMe(session.user.id);
  }

  /**
   * PATCH /users/me — обновить свой профиль.
   */
  @Patch('me')
  updateMe(@Body() dto: UpdateUserDto, @Session() session: UserSession) {
    return this.service.updateMe(session.user.id, dto);
  }

  /**
   * GET /users/:id — публичный профиль (для страницы хоста).
   * Без email, stripeCustomerId, status.
   */
  @Get(':id')
  @AllowAnonymous()
  findPublic(@Param('id') id: string) {
    return this.service.findPublic(id);
  }
  /**
   * Удаление своего профиля.
   Soft delete (мягкое удаление)
   */
  @Delete('me')
  @HttpCode(HttpStatus.OK)
  deleteMe(@Body() dto: DeleteAccountDto, @Session() session: UserSession) {
    return this.service.deleteMe(session.user.id);
  }
}
