import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { Agent } from 'node:https';
import { LoginDto } from '../dto/login.dto';
import { CreateUserDto } from '../dto/create-user.dto';
import { TokenService } from './token.service';
import { SignupService } from './signup.service';
import { CreateAdminUserDto } from '../dto/create-admin-user.dto';
import { UserRepo } from '@docmost/db/repos/user/user.repo';
import {
  comparePasswordHash,
  hashPassword,
  nanoIdGen,
} from '../../../common/helpers';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { MailService } from '../../../integrations/mail/mail.service';
import ChangePasswordEmail from '@docmost/transactional/emails/change-password-email';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import ForgotPasswordEmail from '@docmost/transactional/emails/forgot-password-email';
import { UserTokenRepo } from '@docmost/db/repos/user-token/user-token.repo';
import { PasswordResetDto } from '../dto/password-reset.dto';
import { User, UserToken, Workspace } from '@docmost/db/types/entity.types';
import { UserTokenType } from '../auth.constants';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { InjectKysely } from 'nestjs-kysely';
import { executeTx } from '@docmost/db/utils';
import { VerifyUserTokenDto } from '../dto/verify-user-token.dto';
import { DomainService } from '../../../integrations/environment/domain.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { AuthResponse, KeycloakAuthUser, KeyCloakUserInfo } from 'src/core/auth/dto/keycloak-payload';
import { FastifyRequest } from 'fastify';
import * as crypto from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    private readonly httpService: HttpService,
    private environmentService: EnvironmentService,
    private signupService: SignupService,
    private tokenService: TokenService,
    private userRepo: UserRepo,
    private userTokenRepo: UserTokenRepo,
    private mailService: MailService,
    private domainService: DomainService,
    // @InjectRedis() private readonly redisClient: Redis,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async login(req: FastifyRequest, loginDto: LoginDto, workspaceId: string) {
    // Generate unique device identifier based on request fingerprint
    const deviceIdentifier = this.generateDeviceIdentifier(req);

    const { email, password } = loginDto;

    if (!email || !password) {
      throw new BadRequestException('Email and password are required');
    }

    // Check if user is locked out due to too many failed attempts (using device fingerprint)
    // await this.checkLoginLockout(deviceIdentifier);

    // const isRoot = email === appConfig.rootLogin;
    // if (isRoot) {
    //  return await this.authAsRoot(email, password, deviceIdentifier, req);
    // }

    const keycloakUser = await this.authKeycloakProvider(email, password);
    if (!keycloakUser) {
      throw new UnauthorizedException('Email not found');
    }

    let user = await this.userRepo.findByEmail(email, workspaceId, {
      includePassword: true,
    });

    if (!user) {
      user = await this.userRepo.insertUser({
        name: keycloakUser.username,
        email: keycloakUser.email,
        password: keycloakUser.email,
        workspaceId: workspaceId,
      });
    }

    if (!user || user?.deletedAt) {
      throw new UnauthorizedException('Email or password does not match');
    }

    user.lastLoginAt = new Date();
    await this.userRepo.updateLastLogin(user.id, workspaceId);

    return this.tokenService.generateAccessToken(user);
  }

  async register(createUserDto: CreateUserDto, workspaceId: string) {
    const user = await this.signupService.signup(createUserDto, workspaceId);
    return this.tokenService.generateAccessToken(user);
  }

  async setup(createAdminUserDto: CreateAdminUserDto) {
    const { workspace, user } =
      await this.signupService.initialSetup(createAdminUserDto);

    const authToken = await this.tokenService.generateAccessToken(user);
    return { workspace, authToken };
  }

  async changePassword(
    dto: ChangePasswordDto,
    userId: string,
    workspaceId: string,
  ): Promise<void> {
    const user = await this.userRepo.findById(userId, workspaceId, {
      includePassword: true,
    });

    if (!user || user.deletedAt) {
      throw new NotFoundException('User not found');
    }

    const comparePasswords = await comparePasswordHash(
      dto.oldPassword,
      user.password,
    );

    if (!comparePasswords) {
      throw new BadRequestException('Current password is incorrect');
    }

    const newPasswordHash = await hashPassword(dto.newPassword);
    await this.userRepo.updateUser(
      {
        password: newPasswordHash,
        hasGeneratedPassword: false,
      },
      userId,
      workspaceId,
    );

    const emailTemplate = ChangePasswordEmail({ username: user.name });
    await this.mailService.sendToQueue({
      to: user.email,
      subject: 'Your password has been changed',
      template: emailTemplate,
    });
  }

  async forgotPassword(
    forgotPasswordDto: ForgotPasswordDto,
    workspace: Workspace,
  ): Promise<void> {
    const user = await this.userRepo.findByEmail(
      forgotPasswordDto.email,
      workspace.id,
    );

    if (!user || user.deletedAt) {
      return;
    }

    const token = nanoIdGen(16);

    const resetLink = `${this.domainService.getUrl(workspace.hostname)}/password-reset?token=${token}`;

    await this.userTokenRepo.insertUserToken({
      token: token,
      userId: user.id,
      workspaceId: user.workspaceId,
      expiresAt: new Date(new Date().getTime() + 60 * 60 * 1000), // 1 hour
      type: UserTokenType.FORGOT_PASSWORD,
    });

    const emailTemplate = ForgotPasswordEmail({
      username: user.name,
      resetLink: resetLink,
    });

    await this.mailService.sendToQueue({
      to: user.email,
      subject: 'Reset your password',
      template: emailTemplate,
    });
  }

  async passwordReset(
    passwordResetDto: PasswordResetDto,
    workspace: Workspace,
  ) {
    const userToken = await this.userTokenRepo.findById(
      passwordResetDto.token,
      workspace.id,
    );

    if (
      !userToken ||
      userToken.type !== UserTokenType.FORGOT_PASSWORD ||
      userToken.expiresAt < new Date()
    ) {
      throw new BadRequestException('Invalid or expired token');
    }

    const user = await this.userRepo.findById(userToken.userId, workspace.id, {
      includeUserMfa: true,
    });
    if (!user || user.deletedAt) {
      throw new NotFoundException('User not found');
    }

    const newPasswordHash = await hashPassword(passwordResetDto.newPassword);

    await executeTx(this.db, async (trx) => {
      await this.userRepo.updateUser(
        {
          password: newPasswordHash,
          hasGeneratedPassword: false,
        },
        user.id,
        workspace.id,
        trx,
      );

      await trx
        .deleteFrom('userTokens')
        .where('userId', '=', user.id)
        .where('type', '=', UserTokenType.FORGOT_PASSWORD)
        .execute();
    });

    const emailTemplate = ChangePasswordEmail({ username: user.name });
    await this.mailService.sendToQueue({
      to: user.email,
      subject: 'Your password has been changed',
      template: emailTemplate,
    });

    // Check if user has MFA enabled or workspace enforces MFA
    const userHasMfa = user?.['mfa']?.isEnabled || false;
    const workspaceEnforcesMfa = workspace.enforceMfa || false;

    if (userHasMfa || workspaceEnforcesMfa) {
      return {
        requiresLogin: true,
      };
    }

    const authToken = await this.tokenService.generateAccessToken(user);
    return { authToken };
  }

  async verifyUserToken(
    userTokenDto: VerifyUserTokenDto,
    workspaceId: string,
  ): Promise<void> {
    const userToken: UserToken = await this.userTokenRepo.findById(
      userTokenDto.token,
      workspaceId,
    );

    if (
      !userToken ||
      userToken.type !== userTokenDto.type ||
      userToken.expiresAt < new Date()
    ) {
      throw new BadRequestException('Invalid or expired token');
    }
  }

  async getCollabToken(user: User, workspaceId: string) {
    const token = await this.tokenService.generateCollabToken(
      user,
      workspaceId,
    );
    return { token };
  }

  async authKeycloakProvider(
    email: string,
    password: string,
  ): Promise<KeycloakAuthUser | undefined> {
    const logTag = this.authKeycloakProvider.name;

    const keycloak = this.environmentService.getKeycloakUrl();
    const realm = this.environmentService.getKeycloakRealm();
    const clientId = this.environmentService.getKeycloakClientId();
    const secret = this.environmentService.getKeycloakSecret();

    try {
      // Keycloak token endpoint
      const tokenUrl = `${keycloak}/realms/${realm}/protocol/openid-connect/token`;

      const tokenParams = {
        grant_type: 'password',
        client_id: clientId,
        client_secret: secret,
        username: email,
        password: password,
        scope: 'openid profile email',
      };

      // Get token from Keycloak - Axios will automatically serialize the object
      const tokenResponse = await this.httpService.axiosRef.request<AuthResponse>({
        method: 'POST',
        url: tokenUrl,
        data: tokenParams,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        httpsAgent: new Agent({ rejectUnauthorized: false }),
      });

      const tokens: AuthResponse = tokenResponse.data;

      // Optionally, decode token to get user info
      const keycloakUser = await this.getUserInfoFromToken(tokens.access_token);
      if (!keycloakUser) {
        throw new NotFoundException('Keycloak User does not exists!');
      }

      const externalId = keycloakUser.id;
      const externalEmail = keycloakUser.email;

      if (!externalId || !externalEmail) {
        throw new BadRequestException('Email not found in Keycloak');
      }

      return keycloakUser;
    } catch (error) {
      console.log({ logTag, message: 'check keycloak integration', error: error });

      return undefined;
    }
  }

    /**
   * Helper method to extract user info from JWT token
   */
  private async getUserInfoFromToken(accessToken: string): Promise<KeycloakAuthUser | undefined> {
    const logTag = this.getUserInfoFromToken.name;
    
    const keycloak = this.environmentService.getKeycloakUrl();
    const realm = this.environmentService.getKeycloakRealm();

    try {
      // Get user info from Keycloak userinfo endpoint
      const userInfoUrl = `${keycloak}/realms/${realm}/protocol/openid-connect/userinfo`;

      const userInfoResponse = await this.httpService.axiosRef.get<KeyCloakUserInfo>(userInfoUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        httpsAgent: new Agent({ rejectUnauthorized: false }),
      });

      const userInfo: KeyCloakUserInfo = userInfoResponse.data;

      return userInfo
        ? {
            id: userInfo.sub,
            username: userInfo.preferred_username,
            email: userInfo.email,
            firstName: userInfo.given_name,
            lastName: userInfo.family_name,
            roles: userInfo.realm_access?.roles || [],
          }
        : undefined;
    } catch (error) {
      console.error({
        logTag,
        message: 'Error getting user info:',
        error: error,
      });

      return undefined;
    }
  }


  private generateDeviceIdentifier(req: FastifyRequest): string {
    // Collect primary components
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const userAgent = req.headers['user-agent'] || 'unknown';

    // Collect secondary components if available
    const acceptLanguage = req.headers['accept-language'] || '';
    const acceptEncoding = req.headers['accept-encoding'] || '';

    // Create fingerprint string with components
    const fingerprintString = `${ip}|${userAgent}|${acceptLanguage}|${acceptEncoding}`;
    console.log(fingerprintString);
    const hash = crypto.createHash('sha256');
    hash.update(fingerprintString);

    return hash.digest('hex');
  }
}
