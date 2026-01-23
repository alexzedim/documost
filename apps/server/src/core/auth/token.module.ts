import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { TokenService } from './services/token.service';
import { SessionActivityService } from './services/session-activity.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: async (environmentService: EnvironmentService) => {
        return {
          secret: environmentService.getAppSecret(),
          signOptions: {
            expiresIn: environmentService.getJwtTokenExpiresIn(),
            issuer: 'Wiki',
          },
        };
      },
      inject: [EnvironmentService],
    }),
  ],
  providers: [TokenService, SessionActivityService],
  exports: [JwtModule, TokenService, SessionActivityService],
})
export class TokenModule {}
