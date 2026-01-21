import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
  Logger,
} from '@nestjs/common';
import { LoginDto } from './dto/login.dto';
import { AuthService } from './services/auth.service';
import { SetupGuard } from './guards/setup.guard';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';

import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User, Workspace } from '@wiki/db/types/entity.types';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

import { VerifyUserTokenDto } from './dto/verify-user-token.dto';
import { FastifyRequest, FastifyReply } from 'fastify';

// import { ChangePasswordDto } from './dto/change-password.dto';
// import { ForgotPasswordDto } from './dto/forgot-password.dto';
// import { PasswordResetDto } from './dto/password-reset.dto';
// import { validateSsoEnforcement } from './auth.util';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private authService: AuthService,
    private environmentService: EnvironmentService,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @AuthWorkspace() workspace: Workspace,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) res: FastifyReply,
    @Body() loginInput: LoginDto,
  ) {
    const authToken = await this.authService.login(
      req,
      loginInput,
      workspace.id,
    );
    this.setAuthCookie(res, authToken);
  }

  @UseGuards(SetupGuard)
  @HttpCode(HttpStatus.OK)
  @Post('setup')
  async setupWorkspace(
    @Res({ passthrough: true }) res: FastifyReply,
    @Body() createAdminUserDto: CreateAdminUserDto,
  ) {
    const { workspace, authToken } =
      await this.authService.setup(createAdminUserDto);

    this.setAuthCookie(res, authToken);
    return workspace;
  }

  // @UseGuards(JwtAuthGuard)
  // @HttpCode(HttpStatus.OK)
  // @Post('change-password')
  // async changePassword(
  //   @Body() dto: ChangePasswordDto,
  //   @AuthUser() user: User,
  //   @AuthWorkspace() workspace: Workspace,
  // ) {
  //   return this.authService.changePassword(dto, user.id, workspace.id);
  // }

  // @HttpCode(HttpStatus.OK)
  // @Post('forgot-password')
  // async forgotPassword(
  //   @Body() forgotPasswordDto: ForgotPasswordDto,
  //   @AuthWorkspace() workspace: Workspace,
  // ) {
  //   validateSsoEnforcement(workspace);
  //   return this.authService.forgotPassword(forgotPasswordDto, workspace);
  // }

  // @HttpCode(HttpStatus.OK)
  // @Post('password-reset')
  // async passwordReset(
  //   @Res({ passthrough: true }) res: FastifyReply,
  //   @Body() passwordResetDto: PasswordResetDto,
  //   @AuthWorkspace() workspace: Workspace,
  // ) {
  //   const result = await this.authService.passwordReset(
  //     passwordResetDto,
  //     workspace,
  //   );

  //   if (result.requiresLogin) {
  //     return {
  //       requiresLogin: true,
  //     };
  //   }

  //   // Set auth cookie if no MFA is required
  //   this.setAuthCookie(res, result.authToken);
  //   return {
  //     requiresLogin: false,
  //   };
  // }

  @HttpCode(HttpStatus.OK)
  @Post('verify-token')
  async verifyResetToken(
    @Body() verifyUserTokenDto: VerifyUserTokenDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.authService.verifyUserToken(verifyUserTokenDto, workspace.id);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('collab-token')
  async collabToken(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.authService.getCollabToken(user, workspace.id);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Res({ passthrough: true }) res: FastifyReply) {
    res.clearCookie('authToken');
  }

  setAuthCookie(res: FastifyReply, token: string) {
    res.setCookie('authToken', token, {
      httpOnly: true,
      path: '/',
      expires: this.environmentService.getCookieExpiresIn(),
      secure: this.environmentService.isHttps(),
    });
  }
}
