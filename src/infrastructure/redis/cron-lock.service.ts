import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { RedisService } from './redis.service';

const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`;

@Injectable()
export class CronLockService {
  private readonly logger = new Logger(CronLockService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Runs `job` on one instance per period. The lock is kept until `ttlMs` expires, so keep the
   * ttl just under the cron period; a failed run releases it so the next tick can retry.
   * If Redis is down the job runs anyway, because the billing jobs are idempotent.
   */
  async runExclusive(name: string, ttlMs: number, job: () => Promise<void>): Promise<boolean> {
    const key = `${this.redis.keyPrefix}lock:cron:${name}`;
    const token = randomUUID();

    let acquired: boolean;
    try {
      acquired = (await this.redis.client.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
    } catch (err) {
      this.logger.warn(`Cron lock unavailable for ${name}, running without it: ${String(err)}`);
      await job();
      return true;
    }
    if (!acquired) return false;

    try {
      await job();
      return true;
    } catch (err) {
      await this.redis.evalScript(RELEASE_SCRIPT, [key], [token]).catch(() => undefined);
      throw err;
    }
  }
}