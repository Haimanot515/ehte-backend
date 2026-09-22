// src/services/redis/redis-throttler.storage.ts
// Shares rate-limit counters across instances; falls back to in-memory storage.

import { Injectable } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { RedisService } from './redis.service';

type ThrottlerRecord = Awaited<ReturnType<ThrottlerStorage['increment']>>;

const INCR_SCRIPT = `
local hits = redis.call('INCR', KEYS[1])
local pttl = redis.call('PTTL', KEYS[1])
if hits == 1 or pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  pttl = tonumber(ARGV[1])
end
return { hits, pttl }
`;

@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly fallback = new ThrottlerStorageService();

  constructor(private readonly redis: RedisService) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerRecord> {
    if (!this.redis.isConnected) {
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }

    const hitKey = `ehte:throttle:${throttlerName}:${key}`;
    const blockKey = `${hitKey}:blocked`;
    const client = this.redis.client;

    try {
      const blockPttl = await client.pttl(blockKey);
      if (blockPttl > 0) {
        const hitPttl = Math.max(await client.pttl(hitKey), 0);
        const hits = Number(await client.get(hitKey)) || limit + 1;
        return {
          totalHits: hits,
          timeToExpire: Math.ceil(hitPttl / 1000),
          isBlocked: true,
          timeToBlockExpire: Math.ceil(blockPttl / 1000),
        };
      }

      const [totalHits, pttl] = (await client.eval(
        INCR_SCRIPT,
        1,
        hitKey,
        ttl,
      )) as [number, number];

      const isBlocked = totalHits > limit;
      let timeToBlockExpire = 0;
      if (isBlocked && blockDuration > 0) {
        await client.set(blockKey, '1', 'PX', blockDuration);
        timeToBlockExpire = Math.ceil(blockDuration / 1000);
      }

      return {
        totalHits,
        timeToExpire: Math.ceil(pttl / 1000),
        isBlocked,
        timeToBlockExpire,
      };
    } catch {
      return this.fallback.increment(key, ttl, limit, blockDuration, throttlerName);
    }
  }
}