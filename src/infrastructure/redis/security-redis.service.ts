// src/services/redis/security-redis.service.ts

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';
import { evictionProblem } from './redis-safety';

/**
 * Config view for the security connection.
 *
 * Security state (throttle counters, failed-login counters, reset tokens) must
 * not share an instance with the evictable cache: maxmemory-policy applies to
 * the whole instance, so an allkeys-lru cache can evict lockout counters.
 * When REDIS_SECURITY_URL is set, the connection targets that instance. When
 * unset, the real config is returned and it targets the same Redis as the cache.
 */
function securityConfig(config: ConfigService): ConfigService {
  const securityUrl = config.get<string>('REDIS_SECURITY_URL');
  if (!securityUrl) return config;

  const overrides: Record<string, unknown> = { REDIS_URL: securityUrl };
  return {
    get: (key: string, defaultValue?: unknown) =>
      key in overrides ? overrides[key] : config.get(key, defaultValue as never),
  } as unknown as ConfigService;
}

/**
 * Redis connection for state where losing a key weakens a control. Same API
 * and lifecycle as RedisService. Lives in its own file so CacheService can
 * inject it without a circular import through redis.module.ts.
 */
@Injectable()
export class SecurityRedisService extends RedisService {
  // Not `logger`/`config`: the base class already declares those as private.
  private readonly securityLogger = new Logger(SecurityRedisService.name);
  private readonly rootConfig: ConfigService;

  constructor(config: ConfigService) {
    super(securityConfig(config));
    this.rootConfig = config;
  }

  async onModuleInit(): Promise<void> {
    await super.onModuleInit();

    if (!this.rootConfig.get<string>('REDIS_SECURITY_URL')) {
      this.securityLogger.warn(
        'REDIS_SECURITY_URL is not set: throttle and lockout counters share the cache instance.',
      );
    }

    // Can't read the policy if the connection isn't up yet.
    if (this.client.status !== 'ready') return;

    const problem = await evictionProblem(this.client, 'Security Redis');
    if (!problem) return;

    const isProd =
      String(this.rootConfig.get('NODE_ENV') ?? process.env.NODE_ENV) === 'production';
    const waived =
      String(this.rootConfig.get('REDIS_ALLOW_EVICTABLE_SECURITY') ?? '').toLowerCase() === 'true';

    if (isProd && !waived) throw new Error(problem);
    this.securityLogger.error(problem);
  }
}