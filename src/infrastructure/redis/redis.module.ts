// src/services/redis/redis.module.ts

import { Global, Injectable, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { RedisService } from './redis.service';
import { CacheService } from './cache.service';
import { RedisThrottlerStorage } from './redis-throttler.storage';

/**
 * Config view for the security Redis connection.
 *
 * Security state (throttle counters, failed-login counters, reset keys) must
 * not share an instance with the evictable cache: `maxmemory-policy` applies to
 * the whole instance (not per DB), so an `allkeys-lru` cache can evict lockout
 * counters. When REDIS_SECURITY_URL is set, RedisService is pointed at that
 * instance. When it is unset, the real config is returned unchanged and the
 * security connection targets the same Redis as the cache (one extra
 * connection, same behaviour as before).
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
 * Redis connection for security-critical state. Inject this (not RedisService)
 * wherever losing a key weakens a control: throttler storage, failed-login
 * counters, password-reset keys, session revocation markers.
 *
 * Extends RedisService so it gets the same connect/quit lifecycle and API.
 */
@Injectable()
export class SecurityRedisService extends RedisService {
  constructor(config: ConfigService) {
    super(securityConfig(config));
  }
}

// Global: import once in AppModule, inject anywhere.
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    RedisService,
    SecurityRedisService,
    CacheService,
    {
      // Throttle counters live on the security connection.
      provide: RedisThrottlerStorage,
      inject: [SecurityRedisService],
      useFactory: (security: SecurityRedisService) => new RedisThrottlerStorage(security),
    },
  ],
  exports: [RedisService, SecurityRedisService, CacheService, RedisThrottlerStorage],
})
export class RedisModule {}