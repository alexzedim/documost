// /ee/sso/controllers/sso.controller.ts
import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Get,
  Param,
  Res,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { Workspace } from '@docmost/db/types/entity.types';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { SamlService } from '../services/saml.service';
import { OidcService } from '../services/oidc.service';
import { LdapService } from '../services/ldap.service';
import { FastifyReply } from 'fastify';
import { Public } from '../../../common/decorators/public.decorator';

@Controller('sso')
export class SsoController {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly samlService: SamlService,
    private readonly oidcService: OidcService,
    private readonly ldapService: LdapService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('providers')
  async getProviders(@AuthWorkspace() workspace: Workspace) {
    return this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .execute();
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('info')
  async getProviderInfo(@Body() data: { providerId: string }, @AuthWorkspace() workspace: Workspace) {
    return this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('id', '=', data.providerId)
      .where('workspaceId', '=', workspace.id)
      .executeTakeFirst();
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('create')
  async createProvider(@Body() data: any, @AuthWorkspace() workspace: Workspace) {
    return this.db
      .insertInto('authProviders')
      .values({
        ...data,
        workspaceId: workspace.id,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .returningAll()
      .executeTakeFirst();
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('update')
  async updateProvider(@Body() data: any, @AuthWorkspace() workspace: Workspace) {
    return this.db
      .updateTable('authProviders')
      .set({ ...data, updatedAt: new Date() })
      .where('id', '=', data.id)
      .where('workspaceId', '=', workspace.id)
      .returningAll()
      .executeTakeFirst();
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('delete')
  async deleteProvider(@Body() data: { providerId: string }, @AuthWorkspace() workspace: Workspace) {
    return this.db
      .updateTable('authProviders')
      .set({ deletedAt: new Date() })
      .where('id', '=', data.providerId)
      .where('workspaceId', '=', workspace.id)
      .execute();
  }

  @Public()
  @Get('saml/:providerId/login')
  async samlLogin(@Param('providerId') providerId: string, @Res() res: FastifyReply) {
    const loginUrl = await this.samlService.getLoginUrl(providerId);
    res.redirect(loginUrl);
  }

  @Public()
  @Post('saml/:providerId/acs')
  async samlAcs(@Param('providerId') providerId: string, @Body() data: any, @Res() res: FastifyReply) {
    const result = await this.samlService.handleCallback(providerId, data);
    res.setCookie('authToken', result.token);
    res.redirect('/');
  }

  @Public()
  @Get('oidc/:providerId/login')
  async oidcLogin(@Param('providerId') providerId: string, @Res() res: FastifyReply) {
    const loginUrl = await this.oidcService.getLoginUrl(providerId);
    res.redirect(loginUrl);
  }

  @Public()
  @Get('oidc/:providerId/callback')
  async oidcCallback(
    @Param('providerId') providerId: string,
    @Body() data: any,
    @Res() res: FastifyReply,
  ) {
    const result = await this.oidcService.handleCallback(providerId, data);
    res.setCookie('authToken', result.token);
    res.redirect('/');
  }

  @Public()
  @Post('ldap/:providerId/login')
  async ldapLogin(
    @Param('providerId') providerId: string,
    @Body() data: { username: string; password: string },
    @Res() res: FastifyReply,
  ) {
    const result = await this.ldapService.login(providerId, data);
    
    if (result.userHasMfa) {
      return { userHasMfa: true };
    }
    
    res.setCookie('authToken', result.token);
    return { success: true };
  }
}