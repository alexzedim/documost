// /ee/license/services/license.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';

@Injectable()
export class LicenseService {
  private readonly logger = new Logger(LicenseService.name);

  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async getLicenseInfo(workspaceId: string): Promise<any> {
    this.logger.debug(`Getting license info for workspace: ${workspaceId}`);

    // Всегда возвращаем валидную лицензию для разработки
    return {
      licenseKey: 'DEV-LICENSE-KEY',
      plan: 'enterprise',
      trialEndAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      customerName: 'Development',
      seatCount: 100,
      issuedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      trial: true,
    };
  }

  async activateLicense(licenseKey: string, workspaceId: string): Promise<any> {
    this.logger.debug(`Activating license for workspace: ${workspaceId}`);

    // Для разработки - всегда успешно
    await this.db
      .updateTable('workspaces')
      .set({
        licenseKey: licenseKey,
        plan: 'enterprise',
        updatedAt: new Date(),
      })
      .where('id', '=', workspaceId)
      .execute();

    return {
      licenseKey,
      workspaceId,
      customerName: 'Development',
      seatCount: 100,
      trial: true,
    };
  }

  async removeLicense(workspaceId: string): Promise<void> {
    this.logger.debug(`Removing license for workspace: ${workspaceId}`);

    await this.db
      .updateTable('workspaces')
      .set({
        licenseKey: null,
        plan: null,
        updatedAt: new Date(),
      })
      .where('id', '=', workspaceId)
      .execute();
  }

  // Убираем все валидации
  private validateLicenseKey(key: string): boolean {
    return true; // Все ключи валидны
  }

  private decodeLicenseKey(key: string): any {
    // Всегда возвращаем валидные данные
    return {
      customerName: 'Development',
      seatCount: 100,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      trial: true,
    };
  }
}
