import {
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { Reflector } from '@nestjs/core';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { addDays } from 'date-fns';
import { SessionActivityService } from '../../core/auth/services/session-activity.service';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(
    private reflector: Reflector,
    private environmentService: EnvironmentService,
    private sessionActivityService: SessionActivityService,
  ) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }

  handleRequest(err: any, user: any, info: any, ctx: ExecutionContext) {
    if (err || !user) {
      throw err || new UnauthorizedException();
    }

    this.setJoinedWorkspacesCookie(user, ctx);

    // Touch session and update activity asynchronously (non-blocking)
    this.touchSession(user, ctx);

    return user as any;
  }

  setJoinedWorkspacesCookie(user: any, ctx: ExecutionContext) {
    if (this.environmentService.isCloud()) {
      const req = ctx.switchToHttp().getRequest();
      const res = ctx.switchToHttp().getResponse();

      const workspaceId = user?.workspace?.id;
      let workspaceIds = [];
      try {
        workspaceIds = req.cookies.joinedWorkspaces
          ? JSON.parse(req.cookies.joinedWorkspaces)
          : [];
      } catch (err) {
        /* empty */
      }

      if (!workspaceIds.includes(workspaceId)) {
        workspaceIds.push(workspaceId);
      }

      res.setCookie('joinedWorkspaces', JSON.stringify(workspaceIds), {
        httpOnly: false,
        domain: '.' + this.environmentService.getSubdomainHost(),
        path: '/',
        expires: addDays(new Date(), 365),
        secure: this.environmentService.isHttps(),
      });
    }
  }

  /**
   * Touch session to refresh activity timestamp (fire-and-forget, non-blocking)
   * @param user - The authenticated user object
   * @param ctx - The execution context containing the request
   */
  private touchSession(user: any, ctx: ExecutionContext): void {
    const sessionId = (ctx.switchToHttp().getRequest() as any).sessionId;

    if (sessionId) {
      // Fire-and-forget: don't await, don't block the request
      this.sessionActivityService.touchSession(sessionId).catch(
        (error) => {
          // Error is already logged in the service
          // This catch is just to prevent unhandled promise rejection
        },
      );
    } else {
      // Fallback for backward compatibility: update legacy activity
      const userId = user?.user?.id;
      const workspaceId = user?.workspace?.id;

      if (userId && workspaceId) {
        this.sessionActivityService.updateActivity(userId, workspaceId).catch(
          (error) => {
            // Error is already logged in the service
          },
        );
      }
    }
  }
}
