import { Module } from '@nestjs/common';
import { RobotsTxtController } from './robots.txt.controller';
import { VersionController } from './version.controller';
import { VersionService } from './version.service';
import { AuthModule } from '../../core/auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [RobotsTxtController, VersionController],
  providers: [VersionService],
  exports: [AuthModule],
})
export class SecurityModule {}
