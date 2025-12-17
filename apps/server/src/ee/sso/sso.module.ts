// /ee/sso/sso.module.ts
import { Module } from '@nestjs/common';
import { SsoController } from './controllers/sso.controller';
import { SamlService } from './services/saml.service';
import { OidcService } from './services/oidc.service';
import { LdapService } from './services/ldap.service';

@Module({
  providers: [SamlService, OidcService, LdapService],
  controllers: [SsoController],
  exports: [SamlService, OidcService, LdapService],
})
export class SsoModule {}