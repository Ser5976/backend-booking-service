import {
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateBookingDto {
  @IsString()
  propertyId: string;

  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'checkIn должен быть в формате YYYY-MM-DD',
  })
  checkIn: string;

  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'checkOut должен быть в формате YYYY-MM-DD',
  })
  checkOut: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  guests: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  children?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10)
  infants?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  guestMessage?: string;
}
