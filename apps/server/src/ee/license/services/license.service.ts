// /ee/license/services/license.service.ts
import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import * as crypto from 'crypto';

@Injectable()
export class LicenseService {
  constructor(@InjectKysely() private readonly db: KyselyDB) {}

  async getLicenseInfo(workspaceId: string): Promise<any> {
    return this.db
      .selectFrom('licenses')
      .selectAll()
      .where('workspaceId', '=', workspaceId)
      .executeTakeFirst();
  }

  async activateLicense(licenseKey: string, workspaceId: string): Promise<any> {
    // Validate license key format
    if (!this.validateLicenseKey(licenseKey)) {
      throw new BadRequestException('Invalid license key format');
    }

    // Decode and verify license
    const licenseData = this.decodeLicenseKey(licenseKey);

    if (!licenseData) {
      throw new BadRequestException('Invalid license key');
    }

    // Check if license is expired
    if (new Date(licenseData.expiresAt) < new Date()) {
      throw new BadRequestException('License has expired');
    }

    // Store license
    const license = await this.db
      .insertInto('licenses')
      .values({
        id: crypto.randomUUID(),
        licenseKey,
        workspaceId,
        customerName: licenseData.customerName,
        seatCount: licenseData.seatCount,
        issuedAt: new Date(licenseData.issuedAt),
        expiresAt: new Date(licenseData.expiresAt),
        trial: licenseData.trial || false,
        createdAt: new Date(),
      })
      .onConflict((oc) => oc.column('workspaceId').doUpdateSet({
        licenseKey,
        customerName: licenseData.customerName,
        seatCount: licenseData.seatCount,
        issuedAt: new Date(licenseData.issuedAt),
        expiresAt: new Date(licenseData.expiresAt),
      }))
      .returningAll()
      .executeTakeFirst();

    return license;
  }

  async removeLicense(workspaceId: string): Promise<void> {
    await this.db
      .deleteFrom('licenses')
      .where('workspaceId', '=', workspaceId)
      .execute();
  }

  private validateLicenseKey(key: string): boolean {
    // Basic format validation
    return /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key);
  }

  private decodeLicenseKey(key: string): any {
    try {
      // Remove dashes
      const cleanKey = key.replace(/-/g, '');
      
      // Decode base64 (simplified - real implementation would use proper encryption)
      const decoded = Buffer.from(cleanKey, 'hex').toString('utf8');
      const data = JSON.parse(decoded);

      return {
        customerName: data.customer,
        seatCount: data.seats,
        issuedAt: data.issued,
        expiresAt: data.expires,
        trial: data.trial,
      };
    } catch (error) {
      return null;
    }
  }
}