import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class UpdateAvailabilityDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(366) // максимум год за раз
  @IsDateString({}, { each: true })
  dates: string[]; // ISO date (YYYY-MM-DD)

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  priceOverride?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minNightsOverride?: number | null;

  @IsOptional()
  isNullPrice?: boolean; // сбросить priceOverride в null
  @IsOptional()
  isNullMinNights?: boolean;
}
