import { IsString, Equals } from 'class-validator';

export class DeleteAccountDto {
  @IsString()
  @Equals('DELETE', { message: 'Введите DELETE для подтверждения' })
  confirmation: string;
}
