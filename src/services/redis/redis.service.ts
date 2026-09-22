// src/services/redis/redis.service.ts

import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis, { RedisOptions } from 'ioredis';

// Keeps BigInt from throwing JSON.stringify; Decimal/Date already serialize via toJSON.
const jsonReplacer = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value;

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('REDIS_URL');

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
      const password = this.config.get<string>('REDIS_PASSWORD');
      this.client = new Redis({
        ...options,
        host: this.config.get<string>('REDIS_HOST', 'localhost'),
        port: Number(this.config.get('REDIS_PORT', 6379)),
        db: Number(this.config.get('REDIS_DB', 0)),
        ...(password ? { password } : {}),
      });
    }

    this.client.on('error', (err: Error) =>
      this.logger.warn(`Redis error: ${err.message}`),
    );
    this.client.on('connect', () => this.logger.log('Redis connected'));
    this.client.on('close', () => this.logger.warn('Redis connection closed'));
  }

  async onModuleInit() {
    await this.client
      .connect()
      .catch((err: Error) =>
        this.logger.warn(`Redis unavailable at startup: ${err.message}`),
      );
  }

  async onModuleDestroy() {
    await this.client.quit().catch(() => undefined);
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      if (raw === null) return null;
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    try {
      const serialized = JSON.stringify(value, jsonReplacer);
      if (serialized === undefined) return;
      if (ttlSeconds) {
        await this.client.set(key, serialized, 'EX', ttlSeconds);
      } else {
        await this.client.set(key, serialized);
      }
    } catch (err) {
      this.logger.warn(`Cache set failed [${key}]: ${(err as Error).message}`);
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (!keys.length) return;
    try {
      await this.client.del(...keys);
    } catch (err) {
      this.logger.warn(
        `Cache del failed [${keys.join(', ')}]: ${(err as Error).message}`,
      );
    }
  }

  async delByPattern(pattern: string): Promise<void> {
    try {
      let cursor = '0';
      do {
        const [next, keys] = await this.client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          200,
        );
        cursor = next;
        if (keys.length) await this.client.del(...keys);
      } while (cursor !== '0');
    } catch (err) {
      this.logger.warn(
        `Cache delByPattern failed [${pattern}]: ${(err as Error).message}`,
      );
    }
  }

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

  async incrementWithTtl(
    key: string,
    ttlSeconds: number,
  ): Promise<number | null> {
    try {
      const value = await this.client.incr(key);
      if (value === 1 || (await this.client.ttl(key)) === -1) {
        await this.client.expire(key, ttlSeconds);
      }
      return value;
    } catch {
      return null;
    }
  }

  async getRaw(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch {
      return null;
    }
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

  get isConnected(): boolean {
    return this.client.status === 'ready';
  }
}