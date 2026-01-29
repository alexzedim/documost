// /ee/api-key/api-key.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@wiki/db/types/kysely.types';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import { JwtApiKeyPayload, JwtType } from '../../../core/auth/dto/jwt-payload';
import { WorkspaceRepo } from '@wiki/db/repos/workspace/workspace.repo';
import { UserRepo } from '@wiki/db/repos/user/user.repo';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { CreateApiKeyDto } from '@wiki/ee/api-key/dto';
import { User } from '@wiki/db/types/entity.types';
import type { SignOptions } from 'jsonwebtoken';

@Injectable()
export class ApiKeyService {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly environmentService: EnvironmentService,
    private readonly jwtService: JwtService,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly userRepo: UserRepo,
  ) {}

  async createApiKey(
    data: CreateApiKeyDto,
    user: User,
    workspaceId: string,
  ): Promise<any> {
    const userId = user.id;
    const apiKeyId = crypto.randomUUID();

    const payload = {
      sub: userId,
      email: user.email,
      workspaceId,
      apiKeyId,
      type: JwtType.API_KEY,
    };

    const appSecret = this.environmentService.getAppSecret();

    const jwtOptions: SignOptions & { secret: string } = {
      secret: appSecret,
      issuer: 'Wiki',
    };
    const isExpiredDateProvided = Boolean(data.expiresAt);

    if (isExpiredDateProvided) {
      const now = new Date();
      const expiresAt = new Date(data.expiresAt);

      const toSeconds = expiresAt.getTime() - now.getTime() / 1000;
      jwtOptions.expiresIn = `${toSeconds}s`;
    }

    const token: string = this.jwtService.sign(payload, jwtOptions);

    const userToken = await this.db
      .insertInto('userTokens')
      .values({
        id: apiKeyId,
        token: token,
        type: 'api_key',
        userId: userId,
        workspaceId: workspaceId,
        expiresAt: data.expiresAt || null,
      })
      .returningAll()
      .executeTakeFirst();

    const apiKey = await this.db
      .insertInto('apiKeys')
      .values({
        id: apiKeyId,
        name: data.name || null,
        creatorId: userId,
        workspaceId: workspaceId,
        expiresAt: data.expiresAt || null,
      })
      .returningAll()
      .executeTakeFirst();

    const creator = await this.db
      .selectFrom('users')
      .select(['id', 'name', 'avatarUrl'])
      .where('id', '=', userId)
      .executeTakeFirst();

    return {
      id: apiKey.id,
      name: apiKey.name || 'API Key',
      token: token,
      createdAt: apiKey.createdAt,
      expiresAt: apiKey.expiresAt,
      lastUsedAt: apiKey.lastUsedAt,
      creatorId: apiKey.creatorId,
      creator: creator || null,
    };
  }

  private async findSystemUser(workspaceId: string): Promise<User | undefined> {
    return this.db
      .selectFrom('users')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('role', '=', 'owner')
      .orderBy('createdAt', 'asc')
      .limit(1)
      .executeTakeFirst();
  }

  async getApiKeys(user: User, workspaceId: string): Promise<any> {
    const systemUser = await this.findSystemUser(workspaceId);
    const isSystemUser = systemUser && user.id === systemUser.id;

    let query = this.db
      .selectFrom('apiKeys')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .where('deletedAt', 'is', null);

    if (!isSystemUser) {
      query = query.where('creatorId', '=', user.id);
    }

    const apiKeys = await query.execute();

    const userIds = [...new Set(apiKeys.map((key) => key.creatorId))];
    const users =
      userIds.length > 0
        ? await this.db
            .selectFrom('users')
            .select(['id', 'name', 'avatarUrl'])
            .where('id', 'in', userIds)
            .execute()
        : [];

    const userMap = new Map(users.map((user) => [user.id, user]));

    const items = apiKeys.map((key) => ({
      id: key.id,
      name: key.name || 'API Key',
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
      lastUsedAt: key.lastUsedAt,
      creatorId: key.creatorId,
      creator: userMap.get(key.creatorId) || null,
    }));

    return {
      items,
      meta: {
        total: items.length,
        hasPrevPage: false,
        hasNextPage: false,
      },
    };
  }

  async updateApiKey(data: any, workspaceId: string): Promise<any> {
    const apiKey = await this.db
      .updateTable('apiKeys')
      .set({
        name: data.name,
        expiresAt: data.expiresAt,
      })
      .where('id', '=', data.apiKeyId)
      .where('workspaceId', '=', workspaceId)
      .returningAll()
      .executeTakeFirst();

    if (!apiKey) return null;

    await this.db
      .updateTable('userTokens')
      .set({
        expiresAt: data.expiresAt,
      })
      .where('id', '=', data.apiKeyId)
      .where('workspaceId', '=', workspaceId)
      .where('type', '=', 'api_key')
      .execute();

    const creator = await this.db
      .selectFrom('users')
      .select(['id', 'name', 'avatarUrl'])
      .where('id', '=', apiKey.creatorId)
      .executeTakeFirst();

    return {
      id: apiKey.id,
      name: apiKey.name || 'API Key',
      token: undefined,
      createdAt: apiKey.createdAt,
      expiresAt: apiKey.expiresAt,
      lastUsedAt: apiKey.lastUsedAt,
      creatorId: apiKey.creatorId,
      creator: creator || null,
    };
  }

  async revokeApiKey(apiKeyId: string, workspaceId: string): Promise<void> {
    await this.db
      .updateTable('apiKeys')
      .set({ deletedAt: new Date() })
      .where('id', '=', apiKeyId)
      .where('workspaceId', '=', workspaceId)
      .execute();

    await this.db
      .deleteFrom('userTokens')
      .where('id', '=', apiKeyId)
      .where('workspaceId', '=', workspaceId)
      .where('type', '=', 'api_key')
      .execute();
  }

  async validateApiKey(payload: JwtApiKeyPayload): Promise<any> {
    const workspace = await this.workspaceRepo.findById(payload.workspaceId);
    if (!workspace) {
      throw new UnauthorizedException();
    }

    const userToken = await this.db
      .selectFrom('userTokens')
      .selectAll()
      .where('id', '=', payload.apiKeyId)
      .where('workspaceId', '=', payload.workspaceId)
      .where('type', '=', 'api_key')
      .executeTakeFirst();

    if (!userToken) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (userToken.expiresAt && new Date(userToken.expiresAt) < new Date()) {
      throw new UnauthorizedException('API key expired');
    }

    await this.db
      .updateTable('apiKeys')
      .set({ lastUsedAt: new Date() })
      .where('id', '=', userToken.id)
      .execute();

    await this.db 
      .updateTable('userTokens')
      .set({ usedAt: new Date() })
      .where('id', '=', userToken.id)
      .execute();

    const user = await this.userRepo.findById(userToken.userId, workspace.id);
    if (!user) {
      throw new UnauthorizedException();
    }

    return { user, workspace };
  }

  private generateApiKeyToken(): string {
    return `dm_${crypto.randomBytes(32).toString('hex')}`;
  }
}
