import { IsEnum, IsIn, IsInt, IsOptional, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { BookingStatus } from '../../generated/prisma/client.js';

export class QueryBookingsDto {
  @IsOptional()
  @IsIn(['guest', 'host'])
  role?: 'guest' | 'host' = 'guest';

  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number = 0;
}
