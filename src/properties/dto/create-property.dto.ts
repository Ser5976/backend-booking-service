import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEnum,
  IsInt,
  IsBoolean,
  IsNumber,
  Min,
  Max,
  MaxLength,
  MinLength,
  Matches,
  IsLatitude,
  IsLongitude,
} from 'class-validator';
import { Type } from 'class-transformer';
import { PropertyType } from '../../generated/prisma/client.js';

export class CreatePropertyDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(120)
  title: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(50)
  @MaxLength(10_000)
  description: string;

  @IsEnum(PropertyType)
  type: PropertyType;

  // Адрес
  @IsString()
  @IsNotEmpty()
  @MaxLength(60)
  country: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  city: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  region?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  street?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  building?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  apartment?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  postalCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @Type(() => Number)
  @IsLongitude()
  longitude?: number;

  // Вместимость
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  maxGuests: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(50)
  bedrooms?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  beds?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.5)
  @Max(50)
  bathrooms?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(10_000)
  areaSqm?: number;

  // Условия
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  minNights?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  maxNights?: number;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  checkInTime?: string;

  @IsOptional()
  @IsString()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  checkOutTime?: string;

  @IsOptional()
  @IsBoolean()
  instantBook?: boolean;

  @IsOptional()
  @IsBoolean()
  smokingAllowed?: boolean;

  @IsOptional()
  @IsBoolean()
  petsAllowed?: boolean;

  @IsOptional()
  @IsBoolean()
  partiesAllowed?: boolean;

  // Цены (в минимальных единицах — копейки/центы)
  @Type(() => Number)
  @IsInt()
  @Min(100) // минимум 1.00 в валюте
  basePricePerNight: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cleaningFee?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  securityDeposit?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;
}
