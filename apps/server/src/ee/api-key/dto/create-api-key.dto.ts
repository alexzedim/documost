import { IsDateString, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateApiKeyDto {
  @IsDateString()
  @IsOptional()
  expiresAt?: Date;

  @IsString()
  @IsNotEmpty()
  name: string;
}
