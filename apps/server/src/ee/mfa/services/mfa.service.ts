// /ee/mfa/services/mfa.service.ts
import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import * as speakeasy from 'speakeasy';
import * as qrcode from 'qrcode';
import * as bcrypt from 'bcrypt';
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

    const passwordValid = await bcrypt.compare(
      loginInput.password,
      user.password,
    );
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
      .selectFrom('userMfa')
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
      .insertInto('userMfa')
      .values({
        userId,
        secret: secret.base32,
        method: 'totp',
        createdAt: new Date(),
      })
      .onConflict((oc) =>
        oc.column('userId').doUpdateSet({ secret: secret.base32 }),
      )
      .execute();

    return {
      method: 'totp',
      qrCode,
      secret: secret.base32,
      manualKey: secret.base32,
    };
  }

  async enableMfa(
    userId: string,
    secret: string,
    verificationCode: string,
  ): Promise<any> {
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
      backupCodes.map((code) => bcrypt.hash(code, 10)),
    );

    await this.db
      .insertInto('userMfa')
      .values({
        userId,
        secret,
        method: 'totp',
        isEnabled: true,
        backupCodes: hashedBackupCodes,
        createdAt: new Date(),
      })
      .onConflict((oc) =>
        oc.column('userId').doUpdateSet({
          secret,
          isEnabled: true,
          backupCodes: hashedBackupCodes,
        }),
      )
      .execute();

    // Clean up setup data
    await this.db.deleteFrom('userMfa').where('userId', '=', userId).execute();

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

    await this.db.deleteFrom('userMfa').where('userId', '=', userId).execute();

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
        const updatedCodes = backupCodes.filter((c) => c !== hashedCode);
        await this.db
          .updateTable('userMfa')
          .set({ backupCodes: updatedCodes })
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
      backupCodes.map((code) => bcrypt.hash(code, 10)),
    );

    await this.db
      .updateTable('userMfa')
      .set({ backupCodes: hashedBackupCodes })
      .where('userId', '=', userId)
      .execute();

    return backupCodes;
  }
}
