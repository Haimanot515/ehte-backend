import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { request as httpsRequest } from 'https';
import type { Request } from 'express';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;
const TIMEOUT_MS = 5000;

interface TurnstileResult {
  success: boolean;
  'error-codes'?: string[];
}

/**
 * Checks the Cloudflare Turnstile token the client sends in the x-captcha-token header.
 * Turn it on with TURNSTILE_ENABLED=true and TURNSTILE_SECRET_KEY=<secret>.
 * When switched on it fails closed: a missing/bad token, or Cloudflare being unreachable, blocks the request.
 */
@Injectable()
export class TurnstileGuard implements CanActivate {
  private readonly logger = new Logger(TurnstileGuard.name);
  private readonly enabled: boolean;
  private readonly secret: string;

  constructor(config: ConfigService) {
    this.enabled = config.get<boolean>('turnstile.enabled') ?? false;
    this.secret = config.get<string>('turnstile.secretKey') ?? '';

    if (!this.enabled) {
      this.logger.warn('Turnstile is OFF (TURNSTILE_ENABLED is not "true"): captcha checks are skipped.');
    } else if (!this.secret) {
      this.logger.error('TURNSTILE_ENABLED is true but TURNSTILE_SECRET_KEY is empty: all protected requests will be refused.');
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled) return true;

    if (!this.secret) {
      throw new ServiceUnavailableException('captcha_not_configured');
    }

    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers['x-captcha-token'];
    const token = (Array.isArray(header) ? header[0] : header)?.trim();

    if (!token) throw new ForbiddenException('captcha_required');
    if (token.length > MAX_TOKEN_LENGTH) throw new ForbiddenException('captcha_failed');

    const result = await this.verify(token, req.ip);

    if (!result.success) {
      this.logger.warn(`Turnstile rejected a token: ${(result['error-codes'] ?? []).join(',') || 'unknown'}`);
      throw new ForbiddenException('captcha_failed');
    }

    return true;
  }

  private verify(token: string, ip?: string): Promise<TurnstileResult> {
    const params = new URLSearchParams({ secret: this.secret, response: token });
    if (ip) params.set('remoteip', ip);
    const body = params.toString();

    return new Promise<TurnstileResult>((resolve, reject) => {
      const req = httpsRequest(
        VERIFY_URL,
        {
          method: 'POST',
          timeout: TIMEOUT_MS,
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as TurnstileResult);
            } catch {
              reject(new Error('Invalid response from Turnstile'));
            }
          });
        },
      );

      req.on('timeout', () => req.destroy(new Error('Turnstile request timed out')));
      req.on('error', reject);
      req.write(body);
      req.end();
    }).catch((error: Error) => {
      this.logger.error(`Turnstile verification unavailable: ${error.message}`);
      throw new ServiceUnavailableException('captcha_unavailable');
    });
  }
}
