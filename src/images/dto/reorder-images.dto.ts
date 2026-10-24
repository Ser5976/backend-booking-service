import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class ImageOrderItem {
  @IsString()
  id: string;

  @IsBoolean()
  @IsOptional()
  isCover?: boolean;
}

export class ReorderImagesDto {
  @IsString()
  propertyId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ImageOrderItem)
  items: ImageOrderItem[];
}
