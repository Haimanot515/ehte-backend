import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';

import { RequestContextService } from '../request-context/request-context.service';
import { CurrentUserDto } from '../dtos/current-user.dto';

/**
 * Fills in the actor fields (userId, actorName, actorRole, sessionId) on the
 * request-scoped AsyncLocalStorage store that RequestContextMiddleware
 * created earlier in the pipeline.
 *
 * Must run AFTER JwtAuthGuard/JwtStrategy has populated request.user —
 * interceptors always run after guards in Nest's pipeline, so ordering
 * relative to the APP_GUARD entries in AppModule.providers doesn't matter,
 * only that this stays an interceptor (not a guard or middleware).
 */
@Injectable()
export class ActorContextInterceptor implements NestInterceptor {
  constructor(private readonly context: RequestContextService) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const user: CurrentUserDto | undefined = ctx.switchToHttp().getRequest().user;

    if (user) {
      this.context.set({
        userId: user.id,
        // CurrentUserDto has no display name — phone is the only
        // human-identifying field available on it.
        actorName: user.phone,
        // actorRole is a single string in the audit schema; roles[] can
        // hold more than one, so join rather than arbitrarily picking [0].
        actorRole: Array.isArray(user.roles) ? user.roles.join(',') : undefined,
        sessionId: user.sessionId,
      });
    }

    return next.handle();
  }
}