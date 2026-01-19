import { IsDateString, IsNotEmpty, IsString } from 'class-validator';

export class CreateApiKeyDto {
  @IsDateString()
  @IsNotEmpty()
  expiresAt: Date;

  @IsString()
  @IsNotEmpty()
  name: string;
}
