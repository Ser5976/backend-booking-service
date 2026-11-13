import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { Roles, Session } from '@thallesp/nestjs-better-auth';
import type { UserSession } from '@thallesp/nestjs-better-auth';

import { AdminService } from './admin.service.js';
import { QueryUsersDto } from './dto/query-users.dto.js';
import { SetRoleDto } from './dto/set-role.dto.js';
import { toActor } from '../common/auth/actor.js';

@Controller('admin')
@Roles(['ADMIN']) // защита всего контроллера
export class AdminController {
  constructor(private readonly service: AdminService) {}

  // ============================================================
  // ПОЛЬЗОВАТЕЛИ
  // ============================================================

  @Get('users')
  listUsers(@Query() query: QueryUsersDto) {
    return this.service.listUsers(query);
  }

  @Get('users/:id')
  findUser(@Param('id') id: string) {
    return this.service.findUser(id);
  }

  @Patch('users/:id/role')
  setRole(
    @Param('id') id: string,
    @Body() dto: SetRoleDto,
    @Session() session: UserSession,
  ) {
    return this.service.setRole(id, dto, toActor(session.user));
  }

  @Post('users/:id/suspend')
  suspend(@Param('id') id: string, @Session() session: UserSession) {
    return this.service.suspend(id, toActor(session.user));
  }

  @Post('users/:id/restore')
  restore(@Param('id') id: string) {
    return this.service.restore(id);
  }

  @Delete('users/:id')
  deleteUser(@Param('id') id: string, @Session() session: UserSession) {
    return this.service.deleteUser(id, toActor(session.user));
  }
}
