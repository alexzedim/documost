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