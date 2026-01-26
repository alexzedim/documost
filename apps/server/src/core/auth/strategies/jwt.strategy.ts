import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-jwt';
import { EnvironmentService } from '../../../integrations/environment/environment.service';
import { JwtApiKeyPayload, JwtPayload, JwtType } from '../dto/jwt-payload';
import { WorkspaceRepo } from '@wiki/db/repos/workspace/workspace.repo';
import { UserRepo } from '@wiki/db/repos/user/user.repo';
import { FastifyRequest } from 'fastify';
import { extractBearerTokenFromHeader } from '../../../common/helpers';
import { SessionActivityService } from '../services/session-activity.service';
import { ApiKeyService } from '../../../ee/api-key/services/api-key.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  private logger = new Logger('JwtStrategy');

  constructor(
    private userRepo: UserRepo,
    private workspaceRepo: WorkspaceRepo,
    private readonly environmentService: EnvironmentService,
    private sessionActivityService: SessionActivityService,
    private apiKeyService: ApiKeyService,
  ) {
    super({
      jwtFromRequest: (req: FastifyRequest) => {
        return req.cookies?.authToken || extractBearerTokenFromHeader(req);
      },
      ignoreExpiration: false,
      secretOrKey: environmentService.getAppSecret(),
      passReqToCallback: true,
    });
  }

  async validate(req: any, payload: JwtPayload | JwtApiKeyPayload) {
    if (!payload.workspaceId) {
      throw new UnauthorizedException();
    }

    if (req.raw.workspaceId && req.raw.workspaceId !== payload.workspaceId) {
      throw new UnauthorizedException('Workspace does not match');
    }
    console.log(payload.type, JwtType.API_KEY, payload.type === JwtType.API_KEY)
    if (payload.type === JwtType.API_KEY) {
      return this.validateApiKey(req, payload as JwtApiKeyPayload);
    }

    if (payload.type.toUpperCase() !== JwtType.ACCESS.toUpperCase()) {
      throw new UnauthorizedException();
    }

    // Check device-bound session for ACCESS tokens
    const jwtPayload = payload as JwtPayload;
    
    if (!jwtPayload.sessionId) {
      // Fallback for backward compatibility: check legacy activity
      const isSessionActive = await this.sessionActivityService.checkActivity(
        payload.sub,
        payload.workspaceId,
      );
      if (!isSessionActive) {
        throw new UnauthorizedException('Session expired due to inactivity');
      }
    } else {
      // New device-bound session validation
      const deviceId = this.generateDeviceId(req);
      const isSessionValid = await this.sessionActivityService.checkSession(
        jwtPayload.sessionId,
        deviceId,
      );

      if (!isSessionValid) {
        throw new UnauthorizedException('Session invalid or device mismatch');
      }
    }

    const workspace = await this.workspaceRepo.findById(payload.workspaceId);

    if (!workspace) {
      throw new UnauthorizedException();
    }
    const user = await this.userRepo.findById(payload.sub, payload.workspaceId);

    if (!user || user.deactivatedAt || user.deletedAt) {
      throw new UnauthorizedException();
    }

    // Attach sessionId and deviceId to request for controller access
    req.sessionId = jwtPayload.sessionId;
    req.deviceId = jwtPayload.deviceId;

    return { user, workspace };
  }

  /**
   * Generate device ID from server-side fingerprint
   */
  private generateDeviceId(req: any): string {
    const fastifyReq = req.raw || req;
    const ip = fastifyReq.ip || fastifyReq.socket?.remoteAddress || 'unknown';
    const userAgent = fastifyReq.headers?.['user-agent'] || 'unknown';
    const acceptLanguage = fastifyReq.headers?.['accept-language'] || '';
    const acceptEncoding = fastifyReq.headers?.['accept-encoding'] || '';

    const fingerprintString = `${ip}|${userAgent}|${acceptLanguage}|${acceptEncoding}`;
    const hash = require('crypto').createHash('sha256');
    hash.update(fingerprintString);

    return hash.digest('hex');
  }

  private async validateApiKey(req: any, payload: JwtApiKeyPayload) {
    return this.apiKeyService.validateApiKey(payload);
  }
}
