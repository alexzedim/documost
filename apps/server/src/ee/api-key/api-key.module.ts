// /ee/api-key/api-key.module.ts
import { Module } from '@nestjs/common';
import { ApiKeyService } from './services/api-key.service';
import { ApiKeyController } from './controllers/api-key.controller';

@Module({
  providers: [ApiKeyService],
  controllers: [ApiKeyController],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}