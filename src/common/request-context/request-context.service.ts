import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';
import { AuditSource } from '@prisma/client';

export interface RequestContextStore {
  requestId: string;
  ipAddress?: string;
  userAgent?: string;
  method?: string;
  path?: string;
  source?: AuditSource;
  // Filled later (after the auth guard) once the JWT strategy is shared
  userId?: string;
  actorName?: string;
  actorRole?: string;
  sessionId?: string;
}

@Injectable()
export class RequestContextService {
  private readonly als = new AsyncLocalStorage<RequestContextStore>();

  run<T>(store: RequestContextStore, callback: () => T): T {
    return this.als.run(store, callback);
  }

  get(): RequestContextStore | undefined {
    return this.als.getStore();
  }

  set(patch: Partial<RequestContextStore>): void {
    const store = this.als.getStore();
    if (store) Object.assign(store, patch);
  }
}