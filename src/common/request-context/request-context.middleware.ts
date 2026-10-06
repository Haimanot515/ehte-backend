import { Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditSource } from '@prisma/client';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';

import { describeDevice } from '../utils/device-label.util';
import { GeoLookupService } from './geo-lookup.service';
import { RequestContextService } from './request-context.service';

const MAX_TEXT = 100;

// Header values come from the client, so keep them short and plain
function cleanHeader(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed || undefined;
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  constructor(
    private readonly context: RequestContextService,
    private readonly geo: GeoLookupService,
    private readonly config: ConfigService,
  ) {}

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
      client === 'web'
        ? AuditSource.WEB
        : client === 'mobile'
          ? AuditSource.MOBILE
          : AuditSource.API;

    const userAgent = req.headers['user-agent'];

    // Location from the database lookup on the real client IP (needs TRUST_PROXY_HOPS behind nginx)
    const geo = this.geo.lookup(req.ip);

    // Optional: nginx can set these headers itself. Only trusted when nginx overwrites them on every request.
    const trustHeaders = this.config.get<boolean>('geo.trustHeaders', false);
    const headerCountry = trustHeaders ? cleanHeader(req.headers['x-geo-country'], 2) : undefined;
    const country = headerCountry?.toUpperCase() ?? geo.country;
    const city = (trustHeaders ? cleanHeader(req.headers['x-geo-city']) : undefined) ?? geo.city;
    const region = (trustHeaders ? cleanHeader(req.headers['x-geo-region']) : undefined) ?? geo.region;

    const rawVersion = cleanHeader(req.headers['x-app-version'], 32);
    const clientVersion = rawVersion && /^[\w.+-]+$/.test(rawVersion) ? rawVersion : undefined;

    this.context.run(
      {
        requestId,
        ipAddress: req.ip,
        userAgent,
        method: req.method,
        // Drop the query string: it can carry tokens
        path: req.originalUrl.split('?')[0],
        source,
        country,
        city,
        region,
        timezone: geo.timezone,
        asn: geo.asn,
        isp: geo.isp,
        deviceLabel: describeDevice(userAgent) ?? undefined,
        clientVersion,
      },
      () => next(),
    );
  }
}