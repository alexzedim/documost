// /ee/mfa/mfa.module.ts
import { Module } from '@nestjs/common';
import { MfaService } from './services/mfa.service';
import { MfaController } from './controllers/mfa.controller';

@Module({
  providers: [MfaService],
  controllers: [MfaController],
  exports: [MfaService],
})
export class MfaModule {}