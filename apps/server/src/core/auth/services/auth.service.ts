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
import { TokenService } from './token.service';
import { SignupService } from './signup.service';
import { CreateAdminUserDto } from '../dto/create-admin-user.dto';
import { UserRepo } from '@wiki/db/repos/user/user.repo';
import {
  comparePasswordHash,
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
  KeycloakRole,
  ParsedKeycloakRole,
} from 'src/core/auth/dto/keycloak-payload';
import {
  KEYCLOAK_ROLE_SPLITTER,
  SPACE_ROLE_SPLITTER,
  ALLOWED_PREFIX,
} from 'src/common/constants/keycloak.const';
import {
  isValidKeycloakRoleString,
  isValidParsedKeycloakRole,
} from 'src/common/guards/keycloak-role.guard';
import { SpaceRole } from 'src/common/helpers/types/permission';
import { FastifyRequest } from 'fastify';
import * as crypto from 'crypto';
import { RedisService } from '@nestjs-labs/nestjs-ioredis';
import { SpaceService } from 'src/core/space/services/space.service';
import { SpaceMemberRepo } from '@wiki/db/repos/space/space-member.repo';
import { SpaceRepo } from '@wiki/db/repos/space/space.repo';
import { UserRole } from 'src/common/helpers/types/permission';
import { GroupUserRepo } from '@wiki/db/repos/group/group-user.repo';
import { GroupRepo } from '@wiki/db/repos/group/group.repo';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly httpService: HttpService,
    private environmentService: EnvironmentService,
    private signupService: SignupService,
    private spaceService: SpaceService,
    private spaceMemberRepo: SpaceMemberRepo,
    private spaceRepo: SpaceRepo,
    private tokenService: TokenService,
    private userRepo: UserRepo,
    private groupUserRepo: GroupUserRepo,
    private groupRepo: GroupRepo,
    private userTokenRepo: UserTokenRepo,
    private mailService: MailService,
    private domainService: DomainService,
    private redisService: RedisService,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async login(req: FastifyRequest, loginDto: LoginDto, workspaceId: string) {
    const deviceId = this.generateDeviceIdentifier(req);

    try {
      const { email, password } = loginDto;

      // Check if user is locked out due to too many failed attempts (using device fingerprint)
      await this.checkLoginLockout(deviceId);

      // Attempt to authenticate user (local or Keycloak)
      const user = await this.authenticateUser(email, password, workspaceId);

      if (!user || user.deletedAt) {
        throw new UnauthorizedException('User not found');
      }

      // Update last login timestamp
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

  /**
   * Authenticate user with email and password
   * Supports both local password authentication and Keycloak SSO
   * @param email - User email
   * @param password - User password
   * @param workspaceId - Workspace ID
   * @returns Authenticated user or throws UnauthorizedException
   */
  private async authenticateUser(
    email: string,
    password: string,
    workspaceId: string,
  ): Promise<User> {
    // Try to find existing local user
    let user = await this.userRepo.findByEmail(email, workspaceId, {
      includePassword: true,
    });

    // If local user exists, validate password
    if (user) {
      return this.validateLocalUserPassword(user, password);
    }

    // If no local user, try Keycloak authentication
    const keycloakUser = await this.authKeycloakProvider(email, password);
    if (!keycloakUser) {
      throw new UnauthorizedException('Email or password does not match');
    }

    // Try to find user by Keycloak ID
    user = await this.userRepo.findById(keycloakUser.id, workspaceId);

    // If user doesn't exist, create new user from Keycloak data
    if (!user) {
      user = await this.createUserFromKeycloak(keycloakUser, workspaceId);
    } else {
      // Validate user ID consistency between local and Keycloak
      this.validateUserIdConsistency(user, keycloakUser);

      // Update space memberships from Keycloak roles for existing users
      const parsedRoles = this.parseKeycloakRole(keycloakUser.roles);
      if (parsedRoles.length > 0) {
        await this.setupUserSpaceMemberships(user, parsedRoles, workspaceId);
      }
    }

    return user;
  }

  /**
   * Validate local user password
   * @param user - User entity with password hash
   * @param password - Plain text password to validate
   * @returns User if password matches
   * @throws UnauthorizedException if password doesn't match or user has no password
   */
  private async validateLocalUserPassword(
    user: User,
    password: string,
  ): Promise<User> {
    // If user has no password, they must use Keycloak
    if (user.password === null) {
      // Try Keycloak authentication for users without local password
      const keycloakUser = await this.authKeycloakProvider(
        user.email,
        password,
      );
      if (!keycloakUser) {
        throw new UnauthorizedException(
          'This account uses domain authentication. Please use your domain credentials.',
        );
      }
      return user;
    }

    const isPasswordMatch = await comparePasswordHash(password, user.password);

    if (!isPasswordMatch) {
      throw new UnauthorizedException('Email or password does not match');
    }

    return user;
  }

  /**
   * Create a new user from Keycloak authentication data
   * Initializes user with default personal space
   * @param keycloakUser - Keycloak user data
   * @param workspaceId - Workspace ID
   * @returns Created user entity
   */
  private async createUserFromKeycloak(
    keycloakUser: KeycloakAuthUser,
    workspaceId: string,
  ): Promise<User> {
    this.logger.debug({
      message: 'Creating new user from Keycloak',
      keycloakUserId: keycloakUser.id,
      email: keycloakUser.email,
    });

    const user = await this.userRepo.insertUser({
      id: keycloakUser.id,
      name: keycloakUser.username,
      email: keycloakUser.email,
      workspaceId: workspaceId,
      // @todo research
      role: UserRole.ADMIN,
    });

    const defaultEveryoneGroup =
      await this.groupRepo.getDefaultGroup(workspaceId);

    if (defaultEveryoneGroup) {
      await this.groupUserRepo.insertGroupUser({
        userId: user.id,
        groupId: defaultEveryoneGroup.id,
      });
    }

    // Create default personal space for new user
    const { namespace } = extractUsernameAndSpaceName(user.name);

    await this.spaceService.createSpace(user, workspaceId, {
      name: namespace,
      slug: generateSlugId(),
      isSystem: true,
    });

    // Parse Keycloak roles and set up space memberships
    const parsedRoles = this.parseKeycloakRole(keycloakUser.roles);
    if (parsedRoles.length > 0) {
      await this.setupUserSpaceMemberships(user, parsedRoles, workspaceId);
    }

    this.logger.debug({
      message: 'User created successfully from Keycloak',
      userId: user.id,
      email: user.email,
    });

    return user;
  }

  /**
   * Validate user ID consistency between local and Keycloak records
   * Logs warning if IDs don't match, indicating potential data inconsistency
   * @param localUser - Local user entity
   * @param keycloakUser - Keycloak user data
   */
  private validateUserIdConsistency(
    localUser: User,
    keycloakUser: KeycloakAuthUser,
  ): void {
    if (localUser.id !== keycloakUser.id) {
      this.logger.warn({
        message: 'User ID mismatch detected between local and Keycloak user',
        localUserId: localUser.id,
        keycloakUserId: keycloakUser.id,
        localUserEmail: localUser.email,
        keycloakUserEmail: keycloakUser.email,
      });
    }
  }

  /**
   * Parse Keycloak roles from role strings
   * Role string format: PREFIX__SPACE_NAME-ROLE
   * Example: biz-komm-ai__mySpace-admin
   *
   * @param roles - Array of role strings from Keycloak token
   * @returns Array of parsed roles with space name and role
   */
  private parseKeycloakRole(roles: string[] | undefined): ParsedKeycloakRole[] {
    if (!roles || !Array.isArray(roles) || roles.length === 0) {
      return [];
    }

    const parsedRoles: ParsedKeycloakRole[] = [];

    for (const roleString of roles) {
      // Validate role string format
      if (!isValidKeycloakRoleString(roleString, ALLOWED_PREFIX)) {
        continue;
      }

      // Split by keycloak role splitter (e.g., '__')
      const [prefix, suffix] = roleString.split(KEYCLOAK_ROLE_SPLITTER);

      // Check if prefix is in allowed list (double-check)
      if (!ALLOWED_PREFIX.includes(prefix)) {
        continue;
      }

      // Split suffix by space role splitter (e.g., '-')
      // Note: space name can contain dashes, so we need to find the last dash
      const lastDashIndex = suffix.lastIndexOf(SPACE_ROLE_SPLITTER);
      if (lastDashIndex === -1) {
        continue;
      }

      const spaceName = suffix.substring(0, lastDashIndex);
      const role = suffix.substring(lastDashIndex + 1) as KeycloakRole;

      // Build parsed role object
      const parsedRole: ParsedKeycloakRole = {
        space: spaceName,
        role: role,
      };

      // Validate parsed role
      if (isValidParsedKeycloakRole(parsedRole)) {
        parsedRoles.push(parsedRole);
      }
    }

    return parsedRoles;
  }

  /**
   * Map Keycloak role to wiki SpaceRole
   * @param keycloakRole - Keycloak role enum value
   * @returns Corresponding SpaceRole value
   */
  private mapKeycloakRoleToSpaceRole(keycloakRole: KeycloakRole): SpaceRole {
    switch (keycloakRole) {
      case KeycloakRole.OWNER:
      case KeycloakRole.ADMIN:
        return SpaceRole.ADMIN;
      case KeycloakRole.EDITOR:
        return SpaceRole.WRITER;
      case KeycloakRole.NORMAL:
      default:
        return SpaceRole.READER;
    }
  }

  /**
   * Set up user space memberships based on parsed Keycloak roles
   * Creates spaces for OWNER/ADMIN roles if they don't exist
   * @param user - User entity
   * @param parsedRoles - Array of parsed Keycloak roles
   * @param workspaceId - Workspace ID
   */
  private async setupUserSpaceMemberships(
    user: User,
    parsedRoles: ParsedKeycloakRole[],
    workspaceId: string,
  ): Promise<void> {
    for (const parsedRole of parsedRoles) {
      try {
        // Find space by name within workspace (case-insensitive)
        let space = await this.db
          .selectFrom('spaces')
          .selectAll()
          .where('workspaceId', '=', workspaceId)
          .where('name', 'ilike', parsedRole.space)
          .executeTakeFirst();

        if (!space) {
          // Space doesn't exist - check if user can create it
          if (
            parsedRole.role === KeycloakRole.OWNER ||
            parsedRole.role === KeycloakRole.ADMIN
          ) {
            // Create space with user as creator (will auto-add as admin)
            space = await this.spaceService.createSpace(user, workspaceId, {
              name: parsedRole.space,
              slug: generateSlugId(),
              isSystem: true,
            });

            this.logger.debug({
              message: 'Created space from Keycloak role',
              spaceName: parsedRole.space,
              spaceId: space.id,
              userId: user.id,
            });
            // Space creation handles membership automatically, continue to next role
            continue;
          } else {
            // Non-owner/admin cannot create space
            this.logger.debug({
              message:
                'Space not found and user cannot create it (non-owner/admin role)',
              spaceName: parsedRole.space,
              userRole: parsedRole.role,
              userId: user.id,
            });
            continue;
          }
        }

        // Space exists - create/update membership
        const existingMembership =
          await this.spaceMemberRepo.getSpaceMemberByTypeId(space.id, {
            userId: user.id,
          });

        const spaceRole = this.mapKeycloakRoleToSpaceRole(parsedRole.role);

        if (existingMembership) {
          // Update existing membership role if different
          if (existingMembership.role !== spaceRole) {
            await this.spaceMemberRepo.updateSpaceMember(
              { role: spaceRole },
              existingMembership.id,
              space.id,
            );
            this.logger.debug({
              message: 'Updated space membership from Keycloak role',
              userId: user.id,
              spaceId: space.id,
              spaceName: space.name,
              newRole: spaceRole,
            });
          }
        } else {
          // Create new membership
          await this.spaceMemberRepo.insertSpaceMember({
            userId: user.id,
            spaceId: space.id,
            role: spaceRole,
          });
          this.logger.debug({
            message: 'Created space membership from Keycloak role',
            userId: user.id,
            spaceId: space.id,
            spaceName: space.name,
            role: spaceRole,
          });
        }
      } catch (error) {
        this.logger.warn({
          message: 'Failed to set up space membership from Keycloak role',
          userId: user.id,
          spaceName: parsedRole.space,
          role: parsedRole.role,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  async setup(createAdminUserDto: CreateAdminUserDto, req?: FastifyRequest) {
    const { workspace, user } =
      await this.signupService.initialSetup(createAdminUserDto);

    const deviceId = req ? this.generateDeviceIdentifier(req) : undefined;
    const authToken = await this.tokenService.generateAccessToken(
      user,
      deviceId,
    );
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

      const roles = 'groups' in userInfo && Array.isArray(userInfo.groups) && userInfo.groups.length > 0 ? userInfo.groups : [];

      return userInfo
        ? {
            id: userInfo.sub,
            username: userInfo.preferred_username,
            email: userInfo.email,
            firstName: userInfo.given_name,
            lastName: userInfo.family_name,
            roles: roles,
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
