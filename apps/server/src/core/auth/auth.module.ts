import { Global, Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { Agent } from 'node:https';
import { AuthController } from './auth.controller';
import { AuthService } from './services/auth.service';
import { JwtStrategy } from './strategies/jwt.strategy';
import { WorkspaceModule } from '../workspace/workspace.module';
import { SignupService } from './services/signup.service';
import { TokenModule } from './token.module';
import { MfaModule } from '../../ee/mfa/mfa.module.js';
import { SpaceModule } from 'src/core/space/space.module';
import { SessionActivityService } from './services/session-activity.service';
import { DeviceValidatorService } from './services/device-validator.service';
import { ApiKeyModule } from '../../ee/api-key/api-key.module';
import { SetupService } from './services/setup.service';

@Global()
@Module({
  imports: [
    HttpModule.register({
      // @todo add CA cert
      httpsAgent: new Agent({ rejectUnauthorized: false }),
    }),
    TokenModule,
    SpaceModule,
    WorkspaceModule,
    MfaModule,
    ApiKeyModule
  ],
  controllers: [AuthController],
  providers: [AuthService, SignupService, JwtStrategy, SessionActivityService, DeviceValidatorService, SetupService],
  exports: [SignupService, SessionActivityService, DeviceValidatorService],
})
export class AuthModule {}
