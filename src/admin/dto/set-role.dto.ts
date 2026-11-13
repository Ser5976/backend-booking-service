import { IsEnum } from 'class-validator';
import { UserRole } from '../../generated/prisma/client.js';

export class SetRoleDto {
  @IsEnum(UserRole)
  role: UserRole;
}
