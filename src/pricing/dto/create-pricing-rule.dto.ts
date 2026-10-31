import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PricingRuleType } from '../../generated/prisma/client.js';

export class CreatePricingRuleDto {
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  name: string;

  @IsEnum(PricingRuleType)
  type: PricingRuleType;

  @ValidateIf((o) => o.type === 'SEASONAL' || o.type === 'HOLIDAY')
  @IsDateString()
  startDate?: string;

  @ValidateIf((o) => o.type === 'SEASONAL' || o.type === 'HOLIDAY')
  @IsDateString()
  endDate?: string;

  @ValidateIf((o) => o.type === 'WEEKEND')
  @IsArray()
  @ArrayMaxSize(7)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  daysOfWeek?: number[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minNights?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(10)
  multiplier?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(100)
  fixedPrice?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
