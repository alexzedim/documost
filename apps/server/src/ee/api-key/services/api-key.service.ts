// /ee/api-key/api-key.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { JwtApiKeyPayload } from '../../../core/auth/dto/jwt-payload';
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