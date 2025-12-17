// /ee/ee.module.ts
import { Module } from '@nestjs/common';
import { ConfluenceImportService } from './confluence-import/confluence-import.service';
import { AttachmentEeService } from './attachments-ee/attachment-ee.service';
import { MfaModule } from './mfa/mfa.module';
import { ApiKeyModule } from './api-key/api-key.module';
import { TypesenseModule } from './typesense/typesense.module';
import { SsoModule } from './sso/sso.module';
import { AiModule } from './ai/ai.module';
import { BillingModule } from './billing/billing.module';
import { LicenseModule } from './license/license.module';

@Module({
  imports: [
    MfaModule,
    ApiKeyModule,
    TypesenseModule,
    SsoModule,
    AiModule,
    BillingModule,
    LicenseModule,
  ],
  providers: [
    ConfluenceImportService,
    AttachmentEeService,
  ],
  exports: [
    ConfluenceImportService,
    AttachmentEeService,
    MfaModule,
    ApiKeyModule,
    TypesenseModule,
    SsoModule,
    AiModule,
    BillingModule,
    LicenseModule,
  ],
})
export class EeModule {}