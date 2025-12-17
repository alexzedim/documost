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

// /ee/confluence-import/confluence-import.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { FileTask, InsertablePage } from '@docmost/db/types/entity.types';
import { promises as fs } from 'fs';
import * as path from 'path';
import { v7 } from 'uuid';
import { generateSlugId } from '../../common/helpers';
import { generateJitteredKeyBetween } from 'fractional-indexing-jittered';
import { ImportService } from '../../integrations/import/services/import.service';
import { PageService } from '../../core/page/services/page.service';
import { BacklinkRepo } from '@docmost/db/repos/backlink/backlink.repo';
import { executeTx } from '@docmost/db/utils';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { EventName } from '../../common/events/event.contants';
import { getProsemirrorContent } from '../../common/helpers/prosemirror/utils';
import { jsonToText } from '../../collaboration/collaboration.util';

interface ConfluencePage {
  id: string;
  title: string;
  body: string;
  parent?: string;
  ancestors: string[];
}

@Injectable()
export class ConfluenceImportService {
  private readonly logger = new Logger(ConfluenceImportService.name);

  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly importService: ImportService,
    private readonly pageService: PageService,
    private readonly backlinkRepo: BacklinkRepo,
    private eventEmitter: EventEmitter2,
  ) {}

  async processConfluenceImport(opts: {
    extractDir: string;
    fileTask: FileTask;
  }): Promise<void> {
    const { extractDir, fileTask } = opts;

    try {
      // Read Confluence export structure
      const indexPath = path.join(extractDir, 'index.html');
      const pages = await this.parseConfluenceExport(extractDir);

      const pagesMap = new Map<string, any>();
      
      for (const page of pages) {
        pagesMap.set(page.id, {
          id: v7(),
          slugId: generateSlugId(),
          title: page.title,
          content: page.body,
          parentPageId: null,
          confluenceId: page.id,
        });
      }

      // Establish parent-child relationships
      for (const page of pages) {
        const currentPage = pagesMap.get(page.id);
        if (page.parent && pagesMap.has(page.parent)) {
          currentPage.parentPageId = pagesMap.get(page.parent).id;
        }
      }

      // Generate positions
      const siblingsMap = new Map<string | null, any[]>();
      pagesMap.forEach((page) => {
        const group = siblingsMap.get(page.parentPageId) ?? [];
        group.push(page);
        siblingsMap.set(page.parentPageId, group);
      });

      const rootSibs = siblingsMap.get(null);
      if (rootSibs?.length) {
        rootSibs.sort((a, b) => a.title.localeCompare(b.title));
        const nextPosition = await this.pageService.nextPagePosition(fileTask.spaceId);
        
        let prevPos: string | null = null;
        rootSibs.forEach((page, idx) => {
          if (idx === 0) {
            page.position = nextPosition;
          } else {
            page.position = generateJitteredKeyBetween(prevPos, null);
          }
          prevPos = page.position;
        });
      }

      siblingsMap.forEach((sibs, parentId) => {
        if (parentId === null) return;
        sibs.sort((a, b) => a.title.localeCompare(b.title));
        
        let prevPos: string | null = null;
        for (const page of sibs) {
          page.position = generateJitteredKeyBetween(prevPos, null);
          prevPos = page.position;
        }
      });

      // Insert pages into database
      const validPageIds = new Set<string>();
      await executeTx(this.db, async (trx) => {
        for (const [, page] of pagesMap) {
          const pmState = getProsemirrorContent(
            await this.importService.processHTML(page.content)
          );

          const { title, prosemirrorJson } = 
            this.importService.extractTitleAndRemoveHeading(pmState);

          const insertablePage: InsertablePage = {
            id: page.id,
            slugId: page.slugId,
            title: title || page.title,
            icon: null,
            content: prosemirrorJson,
            textContent: jsonToText(prosemirrorJson),
            ydoc: await this.importService.createYdoc(prosemirrorJson),
            position: page.position,
            spaceId: fileTask.spaceId,
            workspaceId: fileTask.workspaceId,
            creatorId: fileTask.creatorId,
            lastUpdatedById: fileTask.creatorId,
            parentPageId: page.parentPageId,
          };

          await trx.insertInto('pages').values(insertablePage).execute();
          validPageIds.add(insertablePage.id);
        }

        if (validPageIds.size > 0) {
          this.eventEmitter.emit(EventName.PAGE_CREATED, {
            pageIds: Array.from(validPageIds),
            workspaceId: fileTask.workspaceId,
          });
        }
      });

      this.logger.log(`Successfully imported ${pagesMap.size} Confluence pages`);
    } catch (error) {
      this.logger.error('Failed to import Confluence pages:', error);
      throw new Error(`Confluence import failed: ${error?.['message']}`);
    }
  }

  private async parseConfluenceExport(extractDir: string): Promise<ConfluencePage[]> {
    const pages: ConfluencePage[] = [];
    const files = await fs.readdir(extractDir);
    
    for (const file of files) {
      if (file.endsWith('.html') && file !== 'index.html') {
        const filePath = path.join(extractDir, file);
        const content = await fs.readFile(filePath, 'utf-8');
        
        pages.push({
          id: path.basename(file, '.html'),
          title: this.extractTitle(content),
          body: content,
          ancestors: [],
        });
      }
    }
    
    return pages;
  }

  private extractTitle(html: string): string {
    const match = html.match(/<title>(.*?)<\/title>/i);
    return match ? match[1] : 'Untitled';
  }
}

// /ee/attachments-ee/attachment-ee.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

@Injectable()
export class AttachmentEeService {
  private readonly logger = new Logger(AttachmentEeService.name);

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async indexAttachment(attachmentId: string): Promise<void> {
    try {
      const attachment = await this.db
        .selectFrom('attachments')
        .selectAll()
        .where('id', '=', attachmentId)
        .executeTakeFirst();

      if (!attachment) {
        this.logger.warn(`Attachment ${attachmentId} not found for indexing`);
        return;
      }

      // Extract text content from attachment based on type
      const textContent = await this.extractTextContent(attachment);

      // Store in vector database or search index
      await this.storeInSearchIndex(attachmentId, textContent);

      this.logger.debug(`Successfully indexed attachment ${attachmentId}`);
    } catch (error) {
      this.logger.error(`Failed to index attachment ${attachmentId}:`, error);
      throw error;
    }
  }

  async indexAttachments(workspaceId: string): Promise<void> {
    try {
      const attachments = await this.db
        .selectFrom('attachments')
        .selectAll()
        .where('workspaceId', '=', workspaceId)
        .where('deletedAt', 'is', null)
        .execute();

      this.logger.log(`Indexing ${attachments.length} attachments for workspace ${workspaceId}`);

      for (const attachment of attachments) {
        try {
          await this.indexAttachment(attachment.id);
        } catch (error) {
          this.logger.error(`Failed to index attachment ${attachment.id}, continuing...`);
        }
      }

      this.logger.log(`Completed indexing attachments for workspace ${workspaceId}`);
    } catch (error) {
      this.logger.error(`Failed to index attachments for workspace ${workspaceId}:`, error);
      throw error;
    }
  }

  private async extractTextContent(attachment: any): Promise<string> {
    // Implementation would depend on file type
    // For PDFs, use pdf-parse
    // For Office docs, use mammoth or similar
    // For images, use OCR if needed
    return '';
  }

  private async storeInSearchIndex(attachmentId: string, content: string): Promise<void> {
    // Store in your search backend (Typesense, Elasticsearch, etc.)
    this.logger.debug(`Storing attachment ${attachmentId} in search index`);
  }
}

// /ee/mfa/mfa.module.ts
import { Module } from '@nestjs/common';
import { MfaService } from './services/mfa.service';
import { MfaController } from './controllers/mfa.controller';

@Module({
  providers: [MfaService],
  controllers: [MfaController],
  exports: [MfaService],
})
export class MfaModule {}

// /ee/mfa/services/mfa.service.ts
import { Injectable, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import * as bcrypt from 'bcryptjs';
import { Workspace } from '@docmost/db/types/entity.types';
import { FastifyReply } from 'fastify';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class MfaService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly jwtService: JwtService,
  ) {}

  async checkMfaRequirements(
    loginInput: any,
    workspace: Workspace,
    res: FastifyReply,
  ): Promise<any> {
    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('email', '=', loginInput.email)
      .where('workspaceId', '=', workspace.id)
      .executeTakeFirst();

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await bcrypt.compare(loginInput.password, user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const mfaSettings = await this.getMfaSettings(user.id);
    const isMfaEnforced = workspace.enforceMfa || false;

    if (mfaSettings?.isEnabled) {
      // User has MFA enabled, require verification
      return {
        userHasMfa: true,
        requiresMfaSetup: false,
        isMfaEnforced,
      };
    }

    if (isMfaEnforced && !mfaSettings?.isEnabled) {
      // Workspace requires MFA but user hasn't set it up
      return {
        userHasMfa: false,
        requiresMfaSetup: true,
        isMfaEnforced: true,
      };
    }

    // No MFA required, generate auth token
    const authToken = this.jwtService.sign({
      sub: user.id,
      workspaceId: workspace.id,
      type: 'ACCESS',
    });

    return { authToken };
  }

  async getMfaSettings(userId: string): Promise<any> {
    const mfa = await this.db
      .selectFrom('mfaSettings')
      .selectAll()
      .where('userId', '=', userId)
      .executeTakeFirst();

    return mfa;
  }

  async setupMfa(userId: string, method: 'totp' | 'email'): Promise<any> {
    if (method !== 'totp') {
      throw new BadRequestException('Only TOTP method is supported');
    }

    const user = await this.db
      .selectFrom('users')
      .selectAll()
      .where('id', '=', userId)
      .executeTakeFirst();

    const secret = speakeasy.generateSecret({
      name: `Docmost (${user.email})`,
      length: 32,
    });

    const qrCode = await qrcode.toDataURL(secret.otpauth_url);

    // Store temporary secret (not yet enabled)
    await this.db
      .insertInto('mfaSetup')
      .values({
        userId,
        secret: secret.base32,
        method: 'totp',
        createdAt: new Date(),
      })
      .onConflict((oc) => oc.column('userId').doUpdateSet({ secret: secret.base32 }))
      .execute();

    return {
      method: 'totp',
      qrCode,
      secret: secret.base32,
      manualKey: secret.base32,
    };
  }

  async enableMfa(userId: string, secret: string, verificationCode: string): Promise<any> {
    const verified = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token: verificationCode,
      window: 2,
    });

    if (!verified) {
      throw new BadRequestException('Invalid verification code');
    }

    // Generate backup codes
    const backupCodes = this.generateBackupCodes(10);
    const hashedBackupCodes = await Promise.all(
      backupCodes.map(code => bcrypt.hash(code, 10))
    );

    await this.db
      .insertInto('mfaSettings')
      .values({
        userId,
        secret,
        method: 'totp',
        isEnabled: true,
        backupCodes: JSON.stringify(hashedBackupCodes),
        createdAt: new Date(),
      })
      .onConflict((oc) => oc.column('userId').doUpdateSet({
        secret,
        isEnabled: true,
        backupCodes: JSON.stringify(hashedBackupCodes),
      }))
      .execute();

    // Clean up setup data
    await this.db
      .deleteFrom('mfaSetup')
      .where('userId', '=', userId)
      .execute();

    return {
      success: true,
      backupCodes,
    };
  }

  async disableMfa(userId: string, confirmPassword?: string): Promise<any> {
    if (confirmPassword) {
      const user = await this.db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', userId)
        .executeTakeFirst();

      const valid = await bcrypt.compare(confirmPassword, user.password);
      if (!valid) {
        throw new BadRequestException('Invalid password');
      }
    }

    await this.db
      .deleteFrom('mfaSettings')
      .where('userId', '=', userId)
      .execute();

    return { success: true };
  }

  async verifyMfa(userId: string, code: string): Promise<boolean> {
    const settings = await this.getMfaSettings(userId);
    if (!settings) {
      throw new BadRequestException('MFA not enabled');
    }

    // Check TOTP code
    const verified = speakeasy.totp.verify({
      secret: settings.secret,
      encoding: 'base32',
      token: code,
      window: 2,
    });

    if (verified) {
      return true;
    }

    // Check backup codes
    const backupCodes = JSON.parse(settings.backupCodes || '[]');
    for (const hashedCode of backupCodes) {
      if (await bcrypt.compare(code, hashedCode)) {
        // Remove used backup code
        const updatedCodes = backupCodes.filter(c => c !== hashedCode);
        await this.db
          .updateTable('mfaSettings')
          .set({ backupCodes: JSON.stringify(updatedCodes) })
          .where('userId', '=', userId)
          .execute();
        return true;
      }
    }

    return false;
  }

  private generateBackupCodes(count: number): string[] {
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const code = Math.random().toString(36).substring(2, 10).toUpperCase();
      codes.push(code);
    }
    return codes;
  }

  async regenerateBackupCodes(userId: string): Promise<string[]> {
    const backupCodes = this.generateBackupCodes(10);
    const hashedBackupCodes = await Promise.all(
      backupCodes.map(code => bcrypt.hash(code, 10))
    );

    await this.db
      .updateTable('mfaSettings')
      .set({ backupCodes: JSON.stringify(hashedBackupCodes) })
      .where('userId', '=', userId)
      .execute();

    return backupCodes;
  }
}

// /ee/mfa/controllers/mfa.controller.ts
import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { MfaService } from '../services/mfa.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { User } from '@docmost/db/types/entity.types';

@Controller('mfa')
export class MfaController {
  constructor(private readonly mfaService: MfaService) {}

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('status')
  async getStatus(@AuthUser() user: User) {
    const settings = await this.mfaService.getMfaSettings(user.id);
    return {
      isEnabled: settings?.isEnabled || false,
      method: settings?.method || null,
      backupCodesCount: settings?.backupCodes ? JSON.parse(settings.backupCodes).length : 0,
    };
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('setup')
  async setup(@AuthUser() user: User, @Body() body: { method: 'totp' | 'email' }) {
    return this.mfaService.setupMfa(user.id, body.method);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('enable')
  async enable(
    @AuthUser() user: User,
    @Body() body: { secret: string; verificationCode: string },
  ) {
    return this.mfaService.enableMfa(user.id, body.secret, body.verificationCode);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('disable')
  async disable(@AuthUser() user: User, @Body() body: { confirmPassword?: string }) {
    return this.mfaService.disableMfa(user.id, body.confirmPassword);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('verify')
  async verify(@AuthUser() user: User, @Body() body: { code: string }) {
    const verified = await this.mfaService.verifyMfa(user.id, body.code);
    return { verified };
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('generate-backup-codes')
  async regenerateBackupCodes(@AuthUser() user: User) {
    const backupCodes = await this.mfaService.regenerateBackupCodes(user.id);
    return { backupCodes };
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('validate-access')
  async validateAccess(@AuthUser() user: User) {
    return {
      valid: true,
      userHasMfa: !!(await this.mfaService.getMfaSettings(user.id))?.isEnabled,
    };
  }
}

// /ee/api-key/api-key.module.ts
import { Module } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { ApiKeyController } from './api-key.controller';

@Module({
  providers: [ApiKeyService],
  controllers: [ApiKeyController],
  exports: [ApiKeyService],
})
export class ApiKeyModule {}

// /ee/api-key/api-key.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { JwtApiKeyPayload } from '../../core/auth/dto/jwt-payload';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { UserRepo } from '@docmost/db/repos/user/user.repo';

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly jwtService: JwtService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly userRepo: UserRepo,
  ) {}

  async createApiKey(data: any, userId: string, workspaceId: string): Promise<any> {
    const token = this.generateApiKeyToken();
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const apiKey = await this.db
      .insertInto('apiKeys')
      .values({
        id: crypto.randomUUID(),
        name: data.name,
        token: hashedToken,
        creatorId: userId,
        workspaceId,
        expiresAt: data.expiresAt || null,
        createdAt: new Date(),
      })
      .returningAll()
      .executeTakeFirst();

    return {
      ...apiKey,
      token, // Only return the plain token on creation
    };
  }

  async getApiKeys(workspaceId: string, params?: any): Promise<any> {
    const apiKeys = await this.db
      .selectFrom('apiKeys')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null)
      .execute();

    return {
      data: apiKeys.map(key => ({ ...key, token: undefined })),
      total: apiKeys.length,
    };
  }

  async updateApiKey(data: any, workspaceId: string): Promise<any> {
    const apiKey = await this.db
      .updateTable('apiKeys')
      .set({ name: data.name, updatedAt: new Date() })
      .where('id', '=', data.apiKeyId)
      .where('workspaceId', '=', workspaceId)
      .returningAll()
      .executeTakeFirst();

    return { ...apiKey, token: undefined };
  }

  async revokeApiKey(apiKeyId: string, workspaceId: string): Promise<void> {
    await this.db
      .updateTable('apiKeys')
      .set({ deletedAt: new Date() })
      .where('id', '=', apiKeyId)
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  async validateApiKey(payload: JwtApiKeyPayload): Promise<any> {
    const workspace = await this.workspaceRepo.findById(payload.workspaceId);
    if (!workspace) {
      throw new UnauthorizedException();
    }

    const apiKey = await this.db
      .selectFrom('apiKeys')
      .selectAll()
      .where('id', '=', payload.apiKeyId)
      .where('workspaceId', '=', payload.workspaceId)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();

    if (!apiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (apiKey.expiresAt && new Date(apiKey.expiresAt) < new Date()) {
      throw new UnauthorizedException('API key expired');
    }

    // Update last used timestamp
    await this.db
      .updateTable('apiKeys')
      .set({ lastUsedAt: new Date() })
      .where('id', '=', apiKey.id)
      .execute();

    const user = await this.userRepo.findById(apiKey.creatorId, workspace.id);
    if (!user) {
      throw new UnauthorizedException();
    }

    return { user, workspace };
  }

  private generateApiKeyToken(): string {
    return `dm_${crypto.randomBytes(32).toString('hex')}`;
  }
}

// /ee/api-key/api-key.controller.ts
import { Controller, Post, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';

@UseGuards(JwtAuthGuard)
@Controller('api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async getApiKeys(@AuthWorkspace() workspace: Workspace, @Body() params?: any) {
    return this.apiKeyService.getApiKeys(workspace.id, params);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async createApiKey(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Body() data: any,
  ) {
    return this.apiKeyService.createApiKey(data, user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async updateApiKey(@AuthWorkspace() workspace: Workspace, @Body() data: any) {
    return this.apiKeyService.updateApiKey(data, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('revoke')
  async revokeApiKey(@AuthWorkspace() workspace: Workspace, @Body() data: { apiKeyId: string }) {
    return this.apiKeyService.revokeApiKey(data.apiKeyId, workspace.id);
  }
}

// /ee/typesense/typesense.module.ts
import { Module } from '@nestjs/common';
import { PageSearchService } from './services/page-search.service';

@Module({
  providers: [PageSearchService],
  exports: [PageSearchService],
})
export class TypesenseModule {}

// /ee/typesense/services/page-search.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import Typesense from 'typesense';

@Injectable()
export class PageSearchService {
  private readonly logger = new Logger(PageSearchService.name);
  private client: Typesense.Client;

  constructor(@InjectKysely() private readonly db: KyselyDB) {
    this.client = new Typesense.Client({
      nodes: [{
        host: process.env.TYPESENSE_HOST || 'localhost',
        port: parseInt(process.env.TYPESENSE_PORT || '8108'),
        protocol: process.env.TYPESENSE_PROTOCOL || 'http',
      }],
      apiKey: process.env.TYPESENSE_API_KEY || '',
      connectionTimeoutSeconds: 2,
    });
  }

  async searchPage(searchParams: any, opts: { userId?: string; workspaceId: string }): Promise<any> {
    const { query, spaceId, shareId } = searchParams;
    const { userId, workspaceId } = opts;

    try {
      const searchParameters = {
        q: query,
        query_by

// Continue /ee/typesense/services/page-search.service.ts
        query_by: 'title,textContent',
        filter_by: `workspaceId:=${workspaceId}`,
        per_page: 20,
      };

      if (spaceId) {
        searchParameters.filter_by += ` && spaceId:=${spaceId}`;
      }

      if (shareId) {
        searchParameters.filter_by += ` && shareId:=${shareId}`;
      }

      const results = await this.client
        .collections('pages')
        .documents()
        .search(searchParameters);

      return {
        data: results.hits?.map(hit => hit.document) || [],
        total: results.found || 0,
      };
    } catch (error) {
      this.logger.error('Typesense search error:', error);
      throw error;
    }
  }

  async indexPage(pageId: string): Promise<void> {
    const page = await this.db
      .selectFrom('pages')
      .selectAll()
      .where('id', '=', pageId)
      .executeTakeFirst();

    if (!page) return;

    await this.client
      .collections('pages')
      .documents()
      .upsert({
        id: page.id,
        title: page.title,
        textContent: page.textContent,
        workspaceId: page.workspaceId,
        spaceId: page.spaceId,
        createdAt: page.createdAt.getTime(),
      });
  }
}

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

// /ee/sso/services/saml.service.ts
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

@Injectable()
export class SamlService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async getLoginUrl(providerId: string): Promise<string> {
    const provider = await this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('id', '=', providerId)
      .executeTakeFirst();

    if (!provider) {
      throw new Error('Provider not found');
    }

    // Generate SAML request and return login URL
    return `${provider.samlUrl}?SAMLRequest=...`;
  }

  async handleCallback(providerId: string, data: any): Promise<{ token: string }> {
    // Validate SAML response
    // Extract user info
    // Create or update user
    // Generate JWT token
    return { token: 'jwt_token' };
  }
}

// /ee/sso/services/oidc.service.ts
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

@Injectable()
export class OidcService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async getLoginUrl(providerId: string): Promise<string> {
    const provider = await this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('id', '=', providerId)
      .executeTakeFirst();

    if (!provider) {
      throw new Error('Provider not found');
    }

    const authUrl = `${provider.oidcIssuer}/authorize`;
    const params = new URLSearchParams({
      client_id: provider.oidcClientId,
      redirect_uri: `${process.env.APP_URL}/api/sso/oidc/${providerId}/callback`,
      response_type: 'code',
      scope: 'openid profile email',
    });

    return `${authUrl}?${params.toString()}`;
  }

  async handleCallback(providerId: string, data: any): Promise<{ token: string }> {
    // Exchange code for tokens
    // Validate ID token
    // Extract user info
    // Create or update user
    // Generate JWT token
    return { token: 'jwt_token' };
  }
}

// /ee/sso/services/ldap.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import * as ldap from 'ldapjs';

@Injectable()
export class LdapService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async login(
    providerId: string,
    credentials: { username: string; password: string },
  ): Promise<{ token?: string; userHasMfa?: boolean }> {
    const provider = await this.db
      .selectFrom('authProviders')
      .selectAll()
      .where('id', '=', providerId)
      .executeTakeFirst();

    if (!provider) {
      throw new Error('Provider not found');
    }

    const client = ldap.createClient({
      url: provider.ldapUrl,
      tlsOptions: provider.ldapTlsEnabled ? { rejectUnauthorized: false } : undefined,
    });

    return new Promise((resolve, reject) => {
      // Bind with service account
      client.bind(provider.ldapBindDn, provider.ldapBindPassword, (err) => {
        if (err) {
          return reject(new UnauthorizedException('LDAP bind failed'));
        }

        // Search for user
        const searchFilter = provider.ldapUserSearchFilter.replace(
          '${username}',
          credentials.username,
        );

        client.search(
          provider.ldapBaseDn,
          {
            filter: searchFilter,
            scope: 'sub',
          },
          (err, res) => {
            if (err) {
              return reject(err);
            }

            let userDn: string | null = null;

            res.on('searchEntry', (entry) => {
              userDn = entry.objectName;
            });

            res.on('end', () => {
              if (!userDn) {
                return reject(new UnauthorizedException('User not found'));
              }

              // Try to bind with user credentials
              client.bind(userDn, credentials.password, (err) => {
                client.unbind();

                if (err) {
                  return reject(new UnauthorizedException('Invalid credentials'));
                }

                // Generate token
                resolve({ token: 'jwt_token' });
              });
            });
          },
        );
      });
    });
  }
}

// /ee/ai/ai.module.ts
import { Module } from '@nestjs/common';
import { AiController } from './controllers/ai.controller';
import { AiService } from './services/ai.service';
import { AiSearchService } from './services/ai-search.service';

@Module({
  providers: [AiService, AiSearchService],
  controllers: [AiController],
  exports: [AiService, AiSearchService],
})
export class AiModule {}

// /ee/ai/controllers/ai.controller.ts
import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Res,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AiService } from '../services/ai.service';
import { AiSearchService } from '../services/ai-search.service';
import { FastifyReply } from 'fastify';

@UseGuards(JwtAuthGuard)
@Controller('ai')
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly aiSearchService: AiSearchService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('generate')
  async generate(
    @Body() data: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.aiService.generateContent(data, user, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('generate/stream')
  async generateStream(
    @Body() data: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    res.raw.setHeader('Content-Type', 'text/event-stream');
    res.raw.setHeader('Cache-Control', 'no-cache');
    res.raw.setHeader('Connection', 'keep-alive');

    await this.aiService.generateContentStream(data, user, workspace, (chunk) => {
      res.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    });

    res.raw.write('data: [DONE]\n\n');
    res.raw.end();
  }

  @HttpCode(HttpStatus.OK)
  @Post('ask')
  async ask(
    @Body() data: any,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Res() res: FastifyReply,
  ) {
    res.raw.setHeader('Content-Type', 'text/event-stream');
    res.raw.setHeader('Cache-Control', 'no-cache');
    res.raw.setHeader('Connection', 'keep-alive');

    const result = await this.aiSearchService.searchAndAnswer(data, user, workspace, (chunk) => {
      res.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    });

    res.raw.write('data: [DONE]\n\n');
    res.raw.end();
  }

  @HttpCode(HttpStatus.OK)
  @Post('config')
  async getConfig(@AuthWorkspace() workspace: Workspace) {
    return {
      configured: !!process.env.OPENAI_API_KEY || !!process.env.ANTHROPIC_API_KEY,
      availableActions: [
        'improve_writing',
        'fix_spelling_grammar',
        'make_shorter',
        'make_longer',
        'simplify',
        'change_tone',
        'summarize',
        'continue_writing',
        'translate',
        'custom',
      ],
    };
  }
}

// /ee/ai/services/ai.service.ts
import { Injectable } from '@nestjs/common';
import { User, Workspace } from '@docmost/db/types/entity.types';
import OpenAI from 'openai';

@Injectable()
export class AiService {
  private openai: OpenAI;

  constructor() {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
  }

  async generateContent(data: any, user: User, workspace: Workspace): Promise<any> {
    const prompt = this.buildPrompt(data);

    const completion = await this.openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    });

    return {
      content: completion.choices[0].message.content,
      usage: {
        promptTokens: completion.usage?.prompt_tokens || 0,
        completionTokens: completion.usage?.completion_tokens || 0,
        totalTokens: completion.usage?.total_tokens || 0,
      },
    };
  }

  async generateContentStream(
    data: any,
    user: User,
    workspace: Workspace,
    onChunk: (chunk: any) => void,
  ): Promise<void> {
    const prompt = this.buildPrompt(data);

    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        onChunk({ content });
      }
    }
  }

  private buildPrompt(data: any): string {
    const { action, content, prompt } = data;

    const actionPrompts = {
      improve_writing: `Improve the following text while maintaining its meaning:\n\n${content}`,
      fix_spelling_grammar: `Fix spelling and grammar in the following text:\n\n${content}`,
      make_shorter: `Make the following text more concise:\n\n${content}`,
      make_longer: `Expand the following text with more details:\n\n${content}`,
      simplify: `Simplify the following text:\n\n${content}`,
      change_tone: `Change the tone of the following text:\n\n${content}`,
      summarize: `Summarize the following text:\n\n${content}`,
      continue_writing: `Continue writing from:\n\n${content}`,
      translate: `Translate the following text:\n\n${content}`,
      custom: prompt || content,
    };

    return actionPrompts[action] || content;
  }
}

// /ee/ai/services/ai-search.service.ts
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { User, Workspace } from '@docmost/db/types/entity.types';
import OpenAI from 'openai';

@Injectable()
export class AiSearchService {
  private openai: OpenAI;

  constructor(@InjectKysely() private readonly db: KyselyDB) {
    if (process.env.OPENAI_API_KEY) {
      this.openai = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
      });
    }
  }

  async searchAndAnswer(
    data: any,
    user: User,
    workspace: Workspace,
    onChunk: (chunk: any) => void,
  ): Promise<any> {
    const { query, spaceId } = data;

    // Search for relevant pages
    let searchQuery = this.db
      .selectFrom('pages')
      .select(['id', 'title', 'textContent', 'slugId'])
      .where('workspaceId', '=', workspace.id)
      .where('deletedAt', 'is', null)
      .limit(5);

    if (spaceId) {
      searchQuery = searchQuery.where('spaceId', '=', spaceId);
    }

    const pages = await searchQuery.execute();

    // Build context from pages
    const context = pages
      .map((p) => `Title: ${p.title}\nContent: ${p.textContent?.substring(0, 500)}`)
      .join('\n\n---\n\n');

    const prompt = `Based on the following documentation, answer the question. If the answer is not in the documentation, say so.

Documentation:
${context}

Question: ${query}

Answer:`;

    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      if (content) {
        onChunk({ content });
      }
    }

    // Send sources
    const sources = pages.map((p) => ({
      pageId: p.id,
      title: p.title,
      slugId: p.slugId,
      similarity: 0.9,
      distance: 0.1,
      chunkIndex: 0,
      excerpt: p.textContent?.substring(0, 200) || '',
    }));

    onChunk({ sources });

    return { sources };
  }
}

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

// /ee/billing/controllers/billing.controller.ts
import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { Workspace } from '@docmost/db/types/entity.types';
import { BillingService } from '../services/billing.service';

@UseGuards(JwtAuthGuard)
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async getBillingInfo(@AuthWorkspace() workspace: Workspace) {
    return this.billingService.getBillingInfo(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('plans')
  async getBillingPlans() {
    return this.billingService.getBillingPlans();
  }

  @HttpCode(HttpStatus.OK)
  @Post('checkout')
  async createCheckoutSession(
    @Body() data: { priceId: string },
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.billingService.createCheckoutSession(data.priceId, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('portal')
  async createPortalSession(@AuthWorkspace() workspace: Workspace) {
    return this.billingService.createPortalSession(workspace);
  }
}

// /ee/billing/services/billing.service.ts
import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { Workspace } from '@docmost/db/types/entity.types';
import Stripe from 'stripe';

@Injectable()
export class BillingService {
  private stripe: Stripe;

  constructor(@InjectKysely() private readonly db: KyselyDB) {
    if (process.env.STRIPE_SECRET_KEY) {
      this.stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
        apiVersion: '2024-11-20.acacia',
      });
    }
  }

  async getBillingInfo(workspaceId: string): Promise<any> {
    return this.db
      .selectFrom('billing')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async getBillingPlans(): Promise<any[]> {
    return [
      {
        name: 'Standard',
        description: 'For small teams',
        productId: 'prod_standard',
        monthlyId: 'price_standard_monthly',
        yearlyId: 'price_standard_yearly',
        currency: 'usd',
        price: {
          monthly: '10',
          yearly: '100',
        },
        features: ['Unlimited pages', 'Collaboration', 'Version history'],
        billingScheme: 'per_seat',
      },
      {
        name: 'Business',
        description: 'For larger organizations',
        productId: 'prod_business',
        monthlyId: 'price_business_monthly',
        yearlyId: 'price_business_yearly',
        currency: 'usd',
        price: {
          monthly: '20',
          yearly: '200',
        },
        features: ['Everything in Standard', 'SSO', 'Advanced permissions'],
        billingScheme: 'per_seat',
      },
    ];
  }

  async createCheckoutSession(priceId: string, workspace: Workspace): Promise<{ url: string }> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.APP_URL}/settings/billing?success=true`,
      cancel_url: `${process.env.APP_URL}/settings/billing?canceled=true`,
      customer_email: workspace.billingEmail,
      metadata: { workspaceId: workspace.id },
    });

    return { url: session.url };
  }

  async createPortalSession(workspace: Workspace): Promise<{ url: string }> {
    const billing = await this.getBillingInfo(workspace.id);

    const session = await this.stripe.billingPortal.sessions.create({
      customer: billing.stripeCustomerId,
      return_url: `${process.env.APP_URL}/settings/billing`,
    });

    return { url: session.url };
  }
}

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

// /ee/license/controllers/license.controller.ts
import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { Workspace } from '@docmost/db/types/entity.types';
import { LicenseService } from '../services/license.service';

@UseGuards(JwtAuthGuard)
@Controller('license')
export class LicenseController {
  constructor(private readonly licenseService: LicenseService) {}

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async getLicenseInfo(@AuthWorkspace() workspace: Workspace) {
    return this.licenseService.getLicenseInfo(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('activate')
  async activateLicense(
    @Body() data: { licenseKey: string },
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.licenseService.activateLicense(data.licenseKey, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('remove')
  async removeLicense(@AuthWorkspace() workspace: Workspace) {
    return this.licenseService.removeLicense(workspace.id);
  }
}

// /ee/license/services/license.service.ts
// import { Injectable, BadRequestException } from '@nestjs/common';
// import { InjectKysely } from 'nestjs-kysely';
// import { KyselyDB } from '@docmost/db/types/kysely.types';
// import * as crypto from 'crypto';

// @Injectable()
// export class LicenseService {
//   constructor(@InjectKysely() private readonly db: KyselyDB) {}

//   async getLicenseInfo(workspaceId: string): Promise<any> {
//     return this.db
//       .selectFrom('licenses')
//       .selectAll()
//       .where('workspaceId', '=', workspaceId)
//       .executeTakeFirst();
//   }

//   async activateLicense(licenseKey: string, workspaceId: string): Promise<any> {
//     // Validate license key format
//     if (!this.validateLicenseKey(licenseKey)) {
//       throw new BadRequestException('Invalid license key format');
//     }

//     // Decode and verify license
//     const licenseData = this.decodeLicenseKey(licenseKey);

//     if (!licenseData) {
//       throw new BadRequestException('Invalid license key');
//     }

//     // Check if license is expired
//     if (new Date(licenseData.expiresAt) < new Date()) {
//       throw new BadRequestException('License has expired');
//     }

//     // Store license
//     const license = await this.db
//       .insertInto('licenses')
//       .values({
//         id: crypto.randomUUID(),
//         licenseKey,
//         workspaceId,
//         customerName: licenseData.customerName,
//         seatCount:



// Continue /ee/typesense/services/page-search.service.ts
        query_by: 'title,textContent',
        filter_by: `workspaceId:=${workspaceId}`,
        per_page: 20,
      };

      if (spaceId) {
        searchParameters.filter_by += ` && spaceId:=${spaceId}`;
      }

      if (shareId) {
        searchParameters.filter_by += ` && shareId:=${shareId}`;
      }

      const results = await this.client
        .collections('pages')
        .documents()
        .search(searchParameters);

      return {
        data: results.hits?.map(hit => hit.document) || [],
        total: results.found || 0,
      };
    } catch (error) {
      this.logger.error('Typesense search error:', error);
      throw error;
    }
  }

  async indexPage(pageId: string): Promise<void> {
    const page = await this.db
      .selectFrom('pages')
      .selectAll()
      .where('id', '=', pageId)
      .executeTakeFirst();

    if (!page) return;

    await this.client
      .collections('pages')
      .documents()
      .upsert({
        id: page.id,
        title: page.title,
        textContent: page.textContent,
        workspaceId: page.workspaceId,
        spaceId: page.spaceId,
        createdAt: page.createdAt.getTime(),
      });
  }
}






























