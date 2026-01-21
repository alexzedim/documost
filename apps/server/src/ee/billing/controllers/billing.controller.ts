// /ee/billing/controllers/billing.controller.ts
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
import { Workspace } from '@wiki/db/types/entity.types';
import { BillingService } from '../services/billing.service';

@UseGuards(JwtAuthGuard)
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @HttpCode(HttpStatus.OK)
  @Post('info')
  async getBillingInfo(@AuthWorkspace() workspace: Workspace) {
    return this.billingService.getBillingInfo(workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('plans')
  async getBillingPlans() {
    return this.billingService.getBillingPlans();
  }

  @HttpCode(HttpStatus.OK)
  @Post('checkout')
  async createCheckoutSession(
    @Body() data: { priceId: string },
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.billingService.createCheckoutSession(data.priceId, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('portal')
  async createPortalSession(@AuthWorkspace() workspace: Workspace) {
    return this.billingService.createPortalSession(workspace);
  }
}
