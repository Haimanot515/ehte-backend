// src/services/redis/redis.service.ts

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';
import { assertSafeRedisConfig } from './redis-safety';

// Keeps BigInt from throwing JSON.stringify; Decimal/Date already serialize via toJSON.
const jsonReplacer = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value;

// Atomic GET-then-DELETE. Portable across Redis versions (doesn't rely on GETDEL,
// which needs Redis >= 6.2) and guarantees no other client can read the value
// between the GET and the DEL.
const GETDEL_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v then redis.call('DEL', KEYS[1]) end
return v
`;

// Atomic INCR + EXPIRE. The naive "INCR, then IF v==1 EXPIRE" is two round trips and can
// leave a counter with no TTL if the process dies in between; this does both in one call.
const INCR_TTL_SCRIPT = `
local v = redis.call('INCR', KEYS[1])
if v == 1 or redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return v
`;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(this.constructor.name);
  readonly client: Redis;

  /** Prefix this connection's keys are namespaced under (e.g. per-env). */
  readonly keyPrefix: string;

  constructor(private readonly config: ConfigService) {
    // FIX: was `'', so an unset REDIS_KEY_PREFIX silently produced UNPREFIXED keys, and
    // purgeAll() would then sweep the raw keyspace (post:*, user:*, ...), which on a shared
    // Redis can also match another application's keys.
    this.keyPrefix = this.config.get<string>('REDIS_KEY_PREFIX', 'ehte:');

    const url = this.config.get<string>('REDIS_URL');
    const password = this.config.get<string>('REDIS_PASSWORD');

    // FIX: production refuses to boot with no password / no TLS. this.constructor.name is
    // 'RedisService' for the cache connection and 'SecurityRedisService' for the other, so
    // the error identifies which one is unsafe.
    assertSafeRedisConfig({ url, password, label: this.constructor.name }, this.config, this.logger);

    const options: RedisOptions = {
      lazyConnect: true,
      enableReadyCheck: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 2,
      connectTimeout: 5000,
      retryStrategy: (times: number) => Math.min(times * 200, 5000),
    };

    if (url) {
      this.client = new Redis(url, options);
    } else {
      this.client = new Redis({
        ...options,
        host: this.config.get<string>('REDIS_HOST', 'localhost'),
        port: Number(this.config.get('REDIS_PORT', 6379)),
        db: Number(this.config.get('REDIS_DB', 0)),
        ...(password ? { password } : {}),
      });
    }

    this.client.on('error', (err: Error) => this.logger.warn(`Redis error: ${err.message}`));
    this.client.on('connect', () => this.logger.log('Redis connected'));
    this.client.on('close', () => this.logger.warn('Redis connection closed'));
  }

  async onModuleInit() {
    await this.client
      .connect()
      .catch((err: Error) => this.logger.warn(`Redis unavailable at startup: ${err.message}`));
  }

  async onModuleDestroy() {
    await this.client.quit().catch(() => undefined);
  }

  // ───────────────────────────────────────────
  // JSON get/set
  // ───────────────────────────────────────────

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /** Returns whether the write succeeded (false on serialize failure or a Redis error). */
  async set(key: string, value: unknown, ttlSeconds?: number): Promise<boolean> {
    try {
      const serialized = this.serialize(value);
      if (serialized === undefined) return false;
      if (ttlSeconds) {
        await this.client.set(key, serialized, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, serialized);
      }
      return true;
    } catch (err) {
      this.logger.warn(`Cache set failed [${key}]: ${(err as Error).message}`);
      return false;
    }
  }

  /** JSON-serializes a value the same way set() does. Returns undefined if it can't be serialized. */
  serialize(value: unknown): string | undefined {
    try {
      return JSON.stringify(value, jsonReplacer);
    } catch {
      return undefined;
    }
  }

  // ───────────────────────────────────────────
  // Delete
  // ───────────────────────────────────────────

  /** Returns whether the delete succeeded (true if there was nothing to delete). */
  async del(...keys: string[]): Promise<boolean> {
    if (!keys.length) return true;
    try {
      await this.client.del(...keys);
      return true;
    } catch (err) {
      this.logger.warn(`Cache del failed [${keys.join(', ')}]: ${(err as Error).message}`);
      return false;
    }
  }

  async delByPattern(pattern: string): Promise<boolean> {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length) await this.client.del(...keys);
      } while (cursor !== '0');
      return true;
    } catch (err) {
      this.logger.warn(`Cache delByPattern failed [${pattern}]: ${(err as Error).message}`);
      return false;
    }
  }

  /** Atomic get-then-delete, so a token (e.g. password reset) can be consumed exactly once. */
  async getAndDelete(key: string): Promise<string | null> {
    const result = await this.client.eval(GETDEL_SCRIPT, 1, key);
    return (result as string | null) ?? null;
  }

  // ───────────────────────────────────────────
  // Raw string get/set (no JSON envelope)
  // ───────────────────────────────────────────

  async getRaw(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
  }

  /**
   * Like getRaw(), but does NOT swallow Redis errors — it throws.
   * Use when the caller needs to tell "key doesn't exist" (null) apart from
   * "Redis errored, don't trust this" (thrown), instead of collapsing both to null.
   */
  async getRawStrict(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async setRaw(key: string, value: string, ttlSeconds?: number): Promise<void> {
    try {
      if (ttlSeconds) {
        await this.client.set(key, value, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, value);
      }
    } catch {
      // non-critical
    }
  }

  // ───────────────────────────────────────────
  // Lua scripts (atomic multi-key ops)
  // ───────────────────────────────────────────

  /**
   * Runs a Lua script via EVAL. Errors are NOT caught here — callers that need
   * "best effort" behavior should wrap the call (as guarded() does); callers
   * that need to know a script failed (e.g. to distinguish a real 0-result
   * from a Redis outage) get the exception directly.
   */
  async evalScript<T>(script: string, keys: string[], args: (string | number)[]): Promise<T> {
    return this.client.eval(script, keys.length, ...keys, ...args) as Promise<T>;
  }

  // ───────────────────────────────────────────
  // Misc
  // ───────────────────────────────────────────

  async exists(key: string): Promise<boolean> {
    try {
      return (await this.client.exists(key)) > 0;
    } catch {
      return false;
    }
  }

  async ttl(key: string): Promise<number> {
    try {
      return await this.client.ttl(key);
    } catch {
      return -2;
    }
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    try {
      await this.client.expire(key, ttlSeconds);
    } catch {
      // non-critical
    }
  }

  async increment(key: string, by = 1): Promise<number | null> {
    try {
      return await this.client.incrby(key, by);
    } catch {
      return null;
    }
  }

  // FIX: was three separate calls (INCR, conditional TTL check, EXPIRE) — a crash between
  // them could leave a counter with no expiry. Now one atomic Lua call.
  async incrementWithTtl(key: string, ttlSeconds: number): Promise<number | null> {
    try {
      return Number(await this.client.eval(INCR_TTL_SCRIPT, 1, key, ttlSeconds));
    } catch {
      return null;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const res = await this.client.ping();
      return res === 'PONG';
    } catch {
      return false;
    }
  }

  getStats() {
    return {
      status: this.client.status,
      connected: this.isConnected,
    };
  }

  get isConnected(): boolean {
    return this.client.status === 'ready';
  }
}