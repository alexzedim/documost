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