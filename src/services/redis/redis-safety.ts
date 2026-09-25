// src/services/redis/redis-safety.ts
//
// Startup checks for the Redis connections. Standalone so RedisService and
// SecurityRedisService only need a one-line call each.

import type Redis from 'ioredis';

export interface RedisConnInfo {
  /** Value of REDIS_URL (or REDIS_SECURITY_URL) if the connection is URL-based. */
  url?: string;
  /** REDIS_PASSWORD, used only in host/port mode. */
  password?: string;
  label: string;
}

interface Warner {
  warn(message: string): void;
}

const truthy = (v: unknown): boolean => String(v ?? '').toLowerCase() === 'true';

/**
 * Production refuses to start with a Redis that has no password or no TLS.
 * TLS: only `rediss://` URLs count. The host/port mode in RedisService does not
 * configure TLS, so it is treated as plaintext.
 * Opt-outs (loud, explicit): REDIS_ALLOW_NO_AUTH=true, REDIS_ALLOW_PLAINTEXT=true.
 * Outside production the same problems are logged as warnings.
 */
export function assertSafeRedisConfig(
  conn: RedisConnInfo,
  env: { get(key: string): unknown },
  logger: Warner,
): void {
  const isProd = String(env.get('NODE_ENV') ?? process.env.NODE_ENV) === 'production';

  let hasPassword = !!conn.password;
  let tls = false;
  if (conn.url) {
    try {
      const u = new URL(conn.url);
      hasPassword = !!u.password;
      tls = u.protocol === 'rediss:';
    } catch {
      throw new Error(`${conn.label}: Redis URL is not a valid URL`);
    }
  }

  const problems: string[] = [];
  if (!hasPassword && !truthy(env.get('REDIS_ALLOW_NO_AUTH'))) {
    problems.push('no password (put it in the URL, or set REDIS_PASSWORD in host/port mode)');
  }
  if (!tls && !truthy(env.get('REDIS_ALLOW_PLAINTEXT'))) {
    problems.push('no TLS (use a rediss:// URL)');
  }
  if (problems.length === 0) return;

  const message = `${conn.label}: insecure Redis config: ${problems.join('; ')}`;
  if (isProd) {
    throw new Error(
      `${message}. Refusing to start in production. ` +
        'Fix it, or opt out with REDIS_ALLOW_NO_AUTH=true / REDIS_ALLOW_PLAINTEXT=true.',
    );
  }
  logger.warn(`${message} (allowed outside production)`);
}

/**
 * Security counters must live on an instance that does not evict keys under
 * memory pressure. Returns a description of the problem, or null if fine or
 * if the policy could not be read (CONFIG is disabled on some managed Redis).
 */
export async function evictionProblem(client: Redis, label: string): Promise<string | null> {
  try {
    const res = (await client.config('GET', 'maxmemory-policy')) as unknown as string[];
    const policy = Array.isArray(res) ? res[1] : undefined;
    if (policy && policy.startsWith('allkeys-')) {
      return (
        `${label}: maxmemory-policy is "${policy}", so throttle and lockout counters can be ` +
        'evicted under memory pressure. Use noeviction or a volatile-* policy on this ' +
        'instance (a separate one from the cache), or set REDIS_ALLOW_EVICTABLE_SECURITY=true.'
      );
    }
    return null;
  } catch {
    return null;
  }
}