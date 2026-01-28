import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
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
import { UserRepo } from '@wiki/db/repos/user/user.repo';
import {
  comparePasswordHash,
  extractBearerTokenFromHeader,
  generateSlugId,
  hashPassword,
  nanoIdGen,
  extractUsernameAndSpaceName,
} from '../../../common/helpers';
import { ChangePasswordDto } from '../dto/change-password.dto';
import { MailService } from '../../../integrations/mail/mail.service';
import ChangePasswordEmail from '@wiki/transactional/emails/change-password-email';
import { ForgotPasswordDto } from '../dto/forgot-password.dto';
import ForgotPasswordEmail from '@wiki/transactional/emails/forgot-password-email';
import { UserTokenRepo } from '@wiki/db/repos/user-token/user-token.repo';
import { PasswordResetDto } from '../dto/password-reset.dto';
import { User, UserToken, Workspace } from '@wiki/db/types/entity.types';
import { UserTokenType } from '../auth.constants';
import { KyselyDB } from '@wiki/db/types/kysely.types';
import { InjectKysely } from 'nestjs-kysely';
import { executeTx } from '@wiki/db/utils';
import { VerifyUserTokenDto } from '../dto/verify-user-token.dto';
import { DomainService } from '../../../integrations/environment/domain.service';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import {
  AuthResponse,
  KeycloakAuthUser,
  KeyCloakUserInfo,
} from 'src/core/auth/dto/keycloak-payload';
import { FastifyRequest } from 'fastify';
import * as crypto from 'crypto';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { SpaceService } from 'src/core/space/services/space.service';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly httpService: HttpService,
    private environmentService: EnvironmentService,
    private signupService: SignupService,
    private spaceService: SpaceService,
    private tokenService: TokenService,
    private userRepo: UserRepo,
    private userTokenRepo: UserTokenRepo,
    private mailService: MailService,
    private domainService: DomainService,
    private redisService: RedisService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async login(req: FastifyRequest, loginDto: LoginDto, workspaceId: string) {
    const deviceId = this.generateDeviceIdentifier(req);

    try {
      // Generate unique device identifier based on request fingerprint
      const { email, password } = loginDto;

      if (!email || !password) {
        throw new BadRequestException('Email and password are required');
      }

      // Check if user is locked out due to too many failed attempts (using device fingerprint)
      await this.checkLoginLockout(deviceId);

      let user = await this.userRepo.findByEmail(email, workspaceId, {
        includePassword: true,
      });
      console.log('login user');
      console.log({ user });
      console.log('==== 1.A ====');
      if (user) {
        if (user.password !== null) {
          const isPasswordMatch = await comparePasswordHash(
            loginDto.password,
            user.password,
          );

          if (!isPasswordMatch) {
            throw new UnauthorizedException('Email or password does not match');
          }
        } else {
          const keycloakUser = await this.authKeycloakProvider(email, password);
          console.log('keycloakUser user');
          console.log({ keycloakUser });
          console.log('==== 1.B ====');
          if (!keycloakUser) {
            throw new UnauthorizedException('Email not found');
          }
        }
      }

      if (!user) {
        const keycloakUser = await this.authKeycloakProvider(email, password);
        console.log('keycloakUser user');
        console.log({ keycloakUser });
        console.log('==== 2.B ====');
        if (!keycloakUser) {
          throw new UnauthorizedException('Domain user not found');
        }

        if (!user) {
          console.log('pre-insert user');
          console.log({
            id: keycloakUser.id,
            name: keycloakUser.username,
            email: keycloakUser.email,
            workspaceId: workspaceId,
          });
          console.log('==== 2.C ====');
          user = await this.userRepo.insertUser({
            id: keycloakUser.id,
            name: keycloakUser.username,
            email: keycloakUser.email,
            workspaceId: workspaceId,
          });
          console.log('after-insert user');
          console.log({
            user,
          });
          console.log('==== 2.C ====');
          const { username, namespace } = extractUsernameAndSpaceName(
            user.name,
          );

          await this.spaceService.createSpace(user, workspaceId, {
            name: namespace,
            description: 'Ваши личное пространство',
            slug: generateSlugId(),
          });
        }
      }

      if (!user || user?.deletedAt) {
        throw new UnauthorizedException('User not found');
      }

      user.lastLoginAt = new Date();
      await this.userRepo.updateLastLogin(user.id, workspaceId);

      return this.tokenService.generateAccessToken(user, deviceId);
    } catch (error) {
      // Record failed attempt for authentication errors
      if (error instanceof HttpException) {
        const status = error.getStatus() as HttpStatus;

        if (
          status === HttpStatus.UNAUTHORIZED ||
          status === HttpStatus.NOT_FOUND
        ) {
          await this.recordFailedLoginAttempt(deviceId);
        }
      }

      throw error;
    }
  }

  async setup(
    createAdminUserDto: CreateAdminUserDto,
    req?: FastifyRequest,
  ) {
    const { workspace, user } =
      await this.signupService.initialSetup(createAdminUserDto);

    const deviceId = req ? this.generateDeviceIdentifier(req) : undefined;
    const authToken = await this.tokenService.generateAccessToken(user, deviceId);
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
      const tokenResponse =
        await this.httpService.axiosRef.request<AuthResponse>({
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
      this.logger.log({
        logTag,
        message: 'check keycloak integration',
        error: error,
      });

      return undefined;
    }
  }

  /**
   * Helper method to extract user info from JWT token
   */
  private async getUserInfoFromToken(
    accessToken: string,
  ): Promise<KeycloakAuthUser | undefined> {
    const logTag = this.getUserInfoFromToken.name;

    const keycloak = this.environmentService.getKeycloakUrl();
    const realm = this.environmentService.getKeycloakRealm();

    try {
      // Get user info from Keycloak userinfo endpoint
      const userInfoUrl = `${keycloak}/realms/${realm}/protocol/openid-connect/userinfo`;

      const userInfoResponse =
        await this.httpService.axiosRef.get<KeyCloakUserInfo>(userInfoUrl, {
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
      this.logger.error({
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
    const hash = crypto.createHash('sha256');
    hash.update(fingerprintString);

    return hash.digest('hex');
  }

  /**
   * Check if user/IP is currently locked out
   * @param identifier - User identifier (email, IP, or combination)
   * @throws HttpException if locked out
   */
  private async checkLoginLockout(identifier: string): Promise<void> {
    const lockoutKey = `login:locked:${identifier}`;
    const redisClient = this.redisService.getOrThrow();
    const ttl = await redisClient.ttl(lockoutKey);

    if (ttl > 0) {
      const minutes = Math.ceil(ttl / 60);
      this.logger.warn(
        `Login attempt blocked for ${identifier}. Locked for ${minutes} more minutes`,
      );

      // Get localized error message
      const message = 'Слишком много неудачных попыток входа.';

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message,
          retryAfter: ttl,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Record a failed login attempt
   * @param identifier - User identifier (email, IP, or combination)
   * @returns Remaining attempts before lockout
   */
  private async recordFailedLoginAttempt(identifier: string): Promise<number> {
    const attemptsKey = `login:attempts:${identifier}`;
    const lockoutKey = `login:locked:${identifier}`;

    const redisClient = this.redisService.getOrThrow();

    const timeoutSeconds = this.environmentService.getWikiLoginTimeoutSeconds();
    const maxAttempts = this.environmentService.getWikiLoginMaxAttempts();

    // Increment attempt counter
    const attempts = await redisClient.incr(attemptsKey);

    // Set expiration on first attempt (attempts reset after timeout period)
    if (attempts === 1) {
      await redisClient.expire(attemptsKey, timeoutSeconds);
    }

    this.logger.debug(
      `Failed login attempt ${attempts}/${maxAttempts} for ${identifier}`,
    );

    // Check if max attempts exceeded
    if (attempts >= maxAttempts) {
      // Lock out the user
      await redisClient.set(
        lockoutKey,
        new Date().toISOString(),
        'EX',
        timeoutSeconds,
      );

      // Clean up attempts counter
      await redisClient.del(attemptsKey);

      this.logger.warn(
        `User ${identifier} locked out after ${attempts} failed attempts. Timeout: ${timeoutSeconds}s`,
      );

      // Get localized error message
      const message = 'Слишком много неудачных попыток входа.';

      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message,
          retryAfter: timeoutSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    return maxAttempts - attempts;
  }
}
