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