import { IsString, IsNotEmpty, MinLength, MaxLength } from 'class-validator';

export class RejectPropertyDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(1000)
  reason: string;
}
