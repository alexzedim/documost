// /ee/sso/services/ldap.service.ts
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
// @ts-ignore
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
      tlsOptions: provider.ldapTlsEnabled
        ? { rejectUnauthorized: false }
        : undefined,
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
                  return reject(
                    new UnauthorizedException('Invalid credentials'),
                  );
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
