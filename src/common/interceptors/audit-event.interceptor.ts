import { CallHandler, ExecutionContext, HttpException, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ActorType, AuditOutcome, AuditSeverity } from '@prisma/client';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';

import { AUDIT_EVENT_KEY, AuditEventOptions } from '../decorators/audit-event.decorator';
import { AuditEventEnum } from '../enums/shared/audit-events.enum';
import { CurrentUserDto } from '../dtos/current-user.dto';
import { resolveActorType } from '../utils/actor-type.util';
import { AuditEventPayload } from '../../modules/misc/audit-log/events/audit.events';

type Req = {
  user?: CurrentUserDto;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: Record<string, unknown>;
};

const SECRET_KEY = /token|password|secret|otp|code|signature/i;

@Injectable()
export class AuditEventInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditEventInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const opts = this.reflector.get<AuditEventOptions | undefined>(AUDIT_EVENT_KEY, ctx.getHandler());
    if (!opts || ctx.getType() !== 'http') return next.handle();
    const req = ctx.switchToHttp().getRequest<Req>();

    return next.handle().pipe(
      tap((res) => {
        if (opts.onSuccess !== false) this.emit(opts, opts.action, req, res);
      }),
      catchError((err: unknown) => {
        const action = typeof opts.onError === 'function' ? opts.onError(err) : opts.onError;
        if (action) this.emit(opts, action, req, undefined, err);
        return throwError(() => err);
      }),
    );
  }

  private emit(opts: AuditEventOptions, action: AuditEventEnum, req: Req, res?: unknown, err?: unknown) {
    try {
      const user = req.user;
      const metadata: Record<string, unknown> = { ...(opts.metadata ?? {}) };
      for (const part of opts.capture ?? []) {
        const src = req[part] ?? {};
        for (const [k, v] of Object.entries(src).slice(0, 20)) {
          if (SECRET_KEY.test(k)) continue;
          if (['string', 'number', 'boolean'].includes(typeof v)) metadata[k] = String(v).slice(0, 200);
        }
      }
      const payload: AuditEventPayload = {
        userId: user?.id ?? null,
        actorType: user ? resolveActorType(user.roles ?? []) : ActorType.USER,
        action,
        entity: opts.entity,
        entityId: this.resolveId(opts, req, res),
        targetUserId: opts.targetUserParam ? this.str(req.params?.[opts.targetUserParam]) : null,
        outcome: err ? AuditOutcome.FAILURE : AuditOutcome.SUCCESS,
        severity: err ? AuditSeverity.WARNING : (opts.severity ?? AuditSeverity.INFO),
        reason: err ? this.errMsg(err) : null,
        metadata: Object.keys(metadata).length ? metadata : null,
      };
      this.eventEmitter.emit(action, payload);
    } catch (e) {
      // Auditing must never break the request.
      this.logger.warn('audit emit failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  private resolveId(opts: AuditEventOptions, req: Req, res: unknown): string | null {
    const id = opts.entityId;
    if (!id) return null;
    if (id.param) return this.str(req.params?.[id.param]);
    if (id.query) return this.str(req.query?.[id.query]);
    if (id.body) return this.str(req.body?.[id.body]);
    if (id.response && res && typeof res === 'object') {
      const o = res as Record<string, unknown>;
      const inner = (o.data && typeof o.data === 'object' ? o.data : {}) as Record<string, unknown>;
      for (const k of id.response) {
        const v = this.str(o[k]) ?? this.str(inner[k]);
        if (v) return v;
      }
    }
    return null;
  }

  private str(v: unknown): string | null {
    return typeof v === 'string' && v ? v.slice(0, 200) : typeof v === 'number' ? String(v) : null;
  }

  private errMsg(err: unknown): string {
    if (err instanceof HttpException) return (err.message || 'http_error').slice(0, 300);
    return (err instanceof Error ? err.message : 'error').slice(0, 300);
  }
}
