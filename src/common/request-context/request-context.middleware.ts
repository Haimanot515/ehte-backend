import { Injectable, NestMiddleware } from '@nestjs/common';
import { AuditSource } from '@prisma/client';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

import { RequestContextService } from './request-context.service';

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(private readonly context: RequestContextService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const incoming = req.headers['x-request-id'];
    const requestId =
      typeof incoming === 'string' && /^[\w-]{8,64}$/.test(incoming)
        ? incoming
        : `req_${randomUUID()}`;

    res.setHeader('x-request-id', requestId);

    // ASSUMPTION: clients send x-client-type: web | mobile. Adjust to what you actually send.
    const client = String(req.headers['x-client-type'] ?? '').toLowerCase();
    const source =
      client === 'web' ? AuditSource.WEB : client === 'mobile' ? AuditSource.MOBILE : AuditSource.API;

    this.context.run(
      {
        requestId,
        ipAddress: req.ip,
        userAgent: req.headers['user-agent'],
        method: req.method,
        // Drop the query string: it can carry tokens
        path: req.originalUrl.split('?')[0],
        source,
      },
      () => next(),
    );
  }
}