import { PartialType } from '@nestjs/mapped-types';
import { CreatePropertyDto } from './create-property.dto.js';

export class UpdatePropertyDto extends PartialType(CreatePropertyDto) {}
