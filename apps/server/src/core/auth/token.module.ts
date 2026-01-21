import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { TokenService } from './services/token.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      useFactory: async (environmentService: EnvironmentService) => {
        return {
          secret: environmentService.getAppSecret(),
          signOptions: {
            // @todo remove, probably manual control this things
            expiresIn: environmentService.getJwtTokenExpiresIn(),
            issuer: 'Wiki',
          },
        };
      },
      inject: [EnvironmentService],
    }),
  ],
  providers: [TokenService],
  exports: [JwtModule, TokenService],
})
export class TokenModule {}
