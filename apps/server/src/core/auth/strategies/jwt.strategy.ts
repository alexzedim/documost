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
      // Validate session exists
      const sessionExists = await this.sessionActivityService.checkSessionExists(
        jwtPayload.sessionId,
      );

      if (!sessionExists) {
        throw new UnauthorizedException('Session expired');
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

    // Attach sessionId to request for controller access
    req.sessionId = jwtPayload.sessionId;

    return { user, workspace };
  }


  private async validateApiKey(req: any, payload: JwtApiKeyPayload) {
    return this.apiKeyService.validateApiKey(payload);
  }
}
