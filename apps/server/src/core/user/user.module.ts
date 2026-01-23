import { Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { UserService } from './user.service';
import { UserController } from './user.controller';
import { UserRepo } from '@wiki/db/repos/user/user.repo';
import { AuthModule } from '../auth/auth.module';
import { SessionActivityService } from '../auth/services/session-activity.service';

@Injectable()
class UserModuleDiagnostics implements OnModuleInit {
  private readonly logger = new Logger(UserModuleDiagnostics.name);

  constructor(
    private readonly sessionActivityService: SessionActivityService,
  ) {}

  onModuleInit() {
    this.logger.log(
      'Resolved SessionActivityService for JwtAuthGuard in UserModule',
    );
  }
}

@Module({
  imports: [AuthModule],
  controllers: [UserController],
  providers: [UserService, UserRepo, UserModuleDiagnostics],
  exports: [UserService, UserRepo],
})
export class UserModule {}
