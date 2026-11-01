import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  ratingOverall: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  ratingClean?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  ratingAccuracy?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  ratingCheckIn?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  ratingLocation?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  ratingValue?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  ratingComm?: number;

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  comment: string;
}
