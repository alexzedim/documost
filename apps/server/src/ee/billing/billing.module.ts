// /ee/billing/billing.module.ts
import { Module } from '@nestjs/common';
import { BillingController } from './controllers/billing.controller';
import { BillingService } from './services/billing.service';

@Module({
  providers: [BillingService],
  controllers: [BillingController],
  exports: [BillingService],
})
export class BillingModule {}