import {
  Controller,
  Post,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiKeyService } from '../services/api-key.service';
import { JwtAuthGuard } from '../../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../../common/decorators/auth-user.decorator';
import { AuthWorkspace } from '../../../common/decorators/auth-workspace.decorator';
import { User, Workspace } from '@wiki/db/types/entity.types';
import { CreateApiKeyDto } from '@wiki/ee/api-key/dto';

@UseGuards(JwtAuthGuard)
@Controller('api-keys')
export class ApiKeyController {
  constructor(private readonly apiKeyService: ApiKeyService) {}

  @HttpCode(HttpStatus.OK)
  @Post()
  async getApiKeys(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Body() params?: any,
  ) {
    return this.apiKeyService.getApiKeys(user, workspace.id, params);
  }

  @HttpCode(HttpStatus.OK)
  @Post('create')
  async createApiKey(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
    @Body() data: CreateApiKeyDto,
  ) {
    return this.apiKeyService.createApiKey(data, user, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('update')
  async updateApiKey(@AuthWorkspace() workspace: Workspace, @Body() data: any) {
    return this.apiKeyService.updateApiKey(data, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('revoke')
  async revokeApiKey(
    @AuthWorkspace() workspace: Workspace,
    @Body() data: { apiKeyId: string },
  ) {
    return this.apiKeyService.revokeApiKey(data.apiKeyId, workspace.id);
  }
}
