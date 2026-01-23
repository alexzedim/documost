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
    MfaModule
  ],
  controllers: [AuthController],
  providers: [AuthService, SignupService, JwtStrategy, SessionActivityService],
  exports: [SignupService, SessionActivityService],
})
export class AuthModule {}
