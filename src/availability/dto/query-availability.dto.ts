import { IsDateString, IsOptional } from 'class-validator';

export class QueryAvailabilityDto {
  @IsOptional()
  @IsDateString()
  from?: string; // ISO date, по умолчанию — сегодня

  @IsOptional()
  @IsDateString()
  to?: string; // ISO date, по умолчанию — from + 90 дней
}
