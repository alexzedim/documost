// /ee/mfa/mfa.module.ts
import { Module } from '@nestjs/common';
import { MfaService } from './services/mfa.service';
import { MfaController } from './controllers/mfa.controller';
import { TokenModule } from '../../core/auth/token.module.js';
import { SessionActivityService } from '../../core/auth/services/session-activity.service';

@Module({
  imports: [TokenModule],
  providers: [MfaService, SessionActivityService],
  controllers: [MfaController],
  exports: [MfaService, SessionActivityService],
})
export class MfaModule {}
