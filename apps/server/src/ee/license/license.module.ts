// /ee/license/license.module.ts
import { Module } from '@nestjs/common';
import { LicenseController } from './controllers/license.controller';
import { LicenseService } from './services/license.service';

@Module({
  providers: [LicenseService],
  controllers: [LicenseController],
  exports: [LicenseService],
})
export class LicenseModule {}