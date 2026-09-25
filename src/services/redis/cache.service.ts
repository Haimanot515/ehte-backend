// src/services/redis/cache.service.ts

import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { RedisService } from './redis.service';
import { SecurityRedisService } from './security-redis.service';
import { buildCacheKeys, CacheKeyBuilder, TTL } from './cache.keys';

const FLAG_MEMO_MS = 2000;

// Queries that would create unbounded / huge cache entries bypass the cache
// (they are still served). Real fix is DTO validation + ValidationPipe whitelist.
const MAX_CACHEABLE_PAGE = 20; // FIX: was 100 — public UIs don't page this deep; pairs with the DTO @Max in core-fixes.patch
const MAX_CACHEABLE_LIMIT = 100;
const MAX_CACHEABLE_QUERY_CHARS = 1024;

// Failed invalidations are retried until they succeed or are older than this
// (longer than any cached value's lifetime, so a dropped one has expired anyway).
const RETRY_MAX_AGE_MS = 20 * 60 * 1000;
const RETRY_INTERVAL_MS = 2000;
const RETRY_QUEUE_MAX = 10_000;

// ── Lua ───────────────────────────────────────────────────────────────────
// Invalidate: bump a version/generation key, drop a tombstone, delete keys.
// KEYS[1]=version|gen key  KEYS[2]=tombstone key  KEYS[3..]=keys to delete
// ARGV[1]=new token  ARGV[2]=tombstone ttl  ARGV[3]=version key ttl (0 = none)
const INVALIDATE = `
if tonumber(ARGV[3]) > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
else
  redis.call('SET', KEYS[1], ARGV[1])
end
redis.call('SET', KEYS[2], '1', 'EX', ARGV[2])
for i = 3, #KEYS do redis.call('DEL', KEYS[i]) end
return 1
`;

// Write only if the entity generation is unchanged since the reader started.
// KEYS[1]=gen key  KEYS[2]=entity key  ARGV[1]=expected gen  ARGV[2]=value  ARGV[3]=ttl
const SET_IF_VERSION = `
local cur = redis.call('GET', KEYS[1])
if not cur then cur = '0' end
if cur ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
return 1
`;

// Legacy set(): refuse to write while a recent invalidation tombstone exists.
// KEYS[1]=tombstone key  KEYS[2]=entity key  ARGV[1]=value  ARGV[2]=ttl
const SET_UNLESS_TOMBSTONE = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[2], ARGV[1], 'EX', ARGV[2])
return 1
`;

// Deep-sorted, JSON-stable so equivalent queries always hash the same.
function stableStringify(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'bigint') return v.toString();
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map((x) => normalize(x) ?? null);
    if (typeof v === 'object') {
      return Object.keys(v)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          const n = normalize((v as Record<string, unknown>)[k]);
          if (n !== undefined) acc[k] = n;
          return acc;
        }, {});
    }
    return v;
  };
  return JSON.stringify(normalize(value)) ?? '';
}

// Stored form of wrap()ped values: soft expiry inside a longer hard TTL, so an
// expired entry can be served once while ONE request refreshes it.
interface Envelope<T> {
  __c: 1;
  v: T;
  s: number;
}
const isEnvelope = (x: unknown): x is Envelope<unknown> =>
  typeof x === 'object' &&
  x !== null &&
  (x as { __c?: unknown }).__c === 1 &&
  typeof (x as { s?: unknown }).s === 'number';

const newToken = () => `${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;

interface PendingOp {
  op: () => Promise<boolean>;
  firstAt: number;
}

// Only the query fields each list actually filters by are hashed into its cache key.
// Anything else (unknown params, ignored filters like information-submission's `status`)
// is dropped before hashing, so it can't multiply the number of cached entries.
const LIST_QUERY_FIELDS: Record<string, readonly string[]> = {
  post: ['type'],
  'missing-person': ['type'],
  'victim-profile': ['supportType'],
  'information-submission': [], // service ignores `status`; nothing else to key on
};

@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly keys: CacheKeyBuilder;
  /** Connection for security state (failed logins, reset tokens). */
  private readonly sec: RedisService;

  private flagMemo = { value: true, checkedAt: 0 };
  private localDisabledUntil = 0;

  private readonly inflight = new Map<string, Promise<unknown>>();

  private readonly retryQueue = new Map<string, PendingOp>();
  private retryTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private needsPurge = false;

  private readonly stats = {
    hits: 0,
    misses: 0,
    staleServed: 0,
    singleFlightJoins: 0,
    writesSkipped: 0,
    bypassed: 0,
    invalidationFailures: 0,
    retried: 0,
    retryDropped: 0,
  };

  constructor(
    private readonly redis: RedisService,
    @Optional() security?: SecurityRedisService,
  ) {
    this.sec = security ?? redis;
    this.keys = buildCacheKeys(this.redis.keyPrefix);

    // Redis is back: replay any invalidations that failed while it was down.
    const onReady = () => void this.flushRetryQueue();
    this.redis.client.on('ready', onReady);
    if (this.sec !== this.redis) this.sec.client.on('ready', onReady);
  }

  onModuleDestroy() {
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
  }

  // ───────────────────────────────────────────
  // Kill switch
  // ───────────────────────────────────────────

  /**
   * Turns caching off for every instance for `ttlSeconds` (default 1h, so it
   * cannot be left off by accident). This instance stops using the cache
   * immediately even if the Redis write fails. Other instances notice within
   * FLAG_MEMO_MS. Returns false if the shared flag could not be written.
   */
  async disableCache(ttlSeconds = 3600): Promise<boolean> {
    this.localDisabledUntil = Date.now() + ttlSeconds * 1000;
    this.flagMemo = { value: false, checkedAt: Date.now() };
    const ok = await this.redis.set(this.keys.cacheEnabled(), false, ttlSeconds);
    if (!ok) this.logger.warn('disableCache: shared flag not written, this instance only');
    return ok;
  }

  async enableCache(): Promise<boolean> {
    this.localDisabledUntil = 0;
    this.flagMemo = { value: true, checkedAt: Date.now() };
    const key = this.keys.cacheEnabled();
    let ok = await this.redis.del(key);
    if (!ok) {
      this.enqueue('enable-flag', () => this.redis.del(key));
      ok = false;
    }
    return ok;
  }

  async isCacheEnabled(): Promise<boolean> {
    const now = Date.now();
    if (now < this.localDisabledUntil) return false;
    if (now - this.flagMemo.checkedAt < FLAG_MEMO_MS) return this.flagMemo.value;
    try {
      const raw = await this.redis.getRawStrict(this.keys.cacheEnabled());
      this.flagMemo = { value: raw === null ? true : JSON.parse(raw) !== false, checkedAt: now };
    } catch {
      // Redis error: keep the last known value instead of assuming "enabled".
      this.flagMemo = { ...this.flagMemo, checkedAt: now };
    }
    return this.flagMemo.value;
  }

  private async canUseCache(): Promise<boolean> {
    return this.redis.isConnected && (await this.isCacheEnabled());
  }

  // ───────────────────────────────────────────
  // Health / metrics
  // ───────────────────────────────────────────

  getMetrics() {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      hitRatio: total ? this.stats.hits / total : null,
      retryQueueSize: this.retryQueue.size,
      needsPurge: this.needsPurge,
      redis: this.redis.getStats(),
      securityRedis: this.sec === this.redis ? 'same-connection-config' : this.sec.getStats(),
    };
  }

  /** For a health indicator (@nestjs/terminus) or an admin endpoint. */
  async health() {
    const [cache, security] = await Promise.all([
      this.redis.ping(),
      this.sec === this.redis ? Promise.resolve(null) : this.sec.ping(),
    ]);
    return {
      cache,
      security,
      cacheEnabled: await this.isCacheEnabled(),
      retryQueueSize: this.retryQueue.size,
    };
  }

  // ───────────────────────────────────────────
  // Low-level helpers
  // ───────────────────────────────────────────

  private jitter(ttl: number): number {
    return Math.max(1, Math.round(ttl * (0.9 + Math.random() * 0.2)));
  }

  // FIX 4: unwraps the SWR envelope so legacy get*() accessors (getMyReports, getMyPosts,
  // getNotifications) don't hand callers a raw { __c, v, s } object when a wrap*() writer
  // shares the same key.
  private async read<T>(key: string): Promise<T | null> {
    if (!(await this.canUseCache())) return null;
    const v = await this.redis.get<T | Envelope<T>>(key);
    if (v === null) {
      this.stats.misses += 1;
      return null;
    }
    this.stats.hits += 1;
    return isEnvelope(v) ? (v.v as T) : (v as T);
  }

  private async write(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!(await this.canUseCache())) return;
    await this.redis.set(key, value, this.jitter(ttlSeconds));
  }

  private async readRaw(key: string): Promise<string | null> {
    if (!(await this.canUseCache())) return null;
    const v = await this.redis.getRaw(key);
    if (v === null) this.stats.misses += 1;
    else this.stats.hits += 1;
    return v;
  }

  private async writeRaw(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!(await this.canUseCache())) return;
    await this.redis.setRaw(key, value, this.jitter(ttlSeconds));
  }

  private hashQuery(query: Record<string, unknown>): string {
    return createHash('sha256').update(stableStringify(query)).digest('hex').slice(0, 32);
  }

  private hashIdentifier(identifier: string): string {
    return createHash('sha256').update(identifier.trim().toLowerCase()).digest('hex');
  }

  // Tokens are case-sensitive, so no lowercasing.
  private hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  // FIX 5: was `isCacheableQuery(query) -> hashQuery(query)`, which hashed the WHOLE query
  // object — an unknown `?x=random` param or an ignored filter (e.g. information-submission's
  // `status`, which the service never applies) each produced a distinct cache key. Now takes
  // an explicit field allow-list per list (LIST_QUERY_FIELDS) and only hashes page/limit plus
  // those fields.
  private listCacheKey(
    query: Record<string, unknown>,
    fields: readonly string[],
  ): { hash: string; cacheable: boolean } {
    const q = query ?? {};
    let cacheable = true;

    const intOr = (raw: unknown, dflt: number): number => {
      if (raw === undefined || raw === null || raw === '') return dflt;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        cacheable = false;
        return dflt;
      }
      return n;
    };

    const page = intOr(q.page, 1);
    const limit = intOr(q.limit, 20);
    if (page > MAX_CACHEABLE_PAGE || limit > MAX_CACHEABLE_LIMIT) cacheable = false;
    if (stableStringify(q).length > MAX_CACHEABLE_QUERY_CHARS) cacheable = false;

    const key: Record<string, unknown> = { page, limit };
    for (const f of fields) {
      const v = q[f];
      if (v === undefined || v === null || v === '') continue;
      if (
        (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') ||
        String(v).length > 64
      ) {
        cacheable = false;
        continue;
      }
      key[f] = v;
    }

    if (!cacheable) this.stats.bypassed += 1;
    return { hash: this.hashQuery(key), cacheable };
  }

  // One factory call per key per process; concurrent callers share the result.
  // The shared object is the same instance for all of them: do not mutate it.
  private singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) {
      this.stats.singleFlightJoins += 1;
      return existing as Promise<T>;
    }
    const p = fn().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  // ───────────────────────────────────────────
  // wrap(): single-flight + TTL jitter + stale-while-revalidate
  // ───────────────────────────────────────────

  async wrap<T>(key: string, factory: () => Promise<T>, ttlSeconds: number): Promise<T> {
    if (!(await this.canUseCache())) return factory();

    const entry = await this.redis.get<unknown>(key);
    if (entry !== null) {
      this.stats.hits += 1;
      if (!isEnvelope(entry)) return entry as T; // value written before envelopes existed
      if (Date.now() < entry.s) return entry.v as T;
      // Soft-expired: serve it once, refresh in the background (single-flight).
      this.stats.staleServed += 1;
      void this.refresh(key, factory, ttlSeconds).catch((err: Error) =>
        this.logger.warn(`Background refresh failed [${key}]: ${err.message}`),
      );
      return entry.v as T;
    }
    this.stats.misses += 1;
    return this.refresh(key, factory, ttlSeconds);
  }

  private refresh<T>(key: string, factory: () => Promise<T>, ttl: number): Promise<T> {
    return this.singleFlight(key, async () => {
      const value = await factory();
      if (value !== null && value !== undefined) {
        const t = this.jitter(ttl);
        const envelope: Envelope<T> = { __c: 1, v: value, s: Date.now() + t * 1000 };
        await this.redis.set(key, envelope, t + Math.min(ttl, TTL.STALE_GRACE));
      }
      return value;
    });
  }

  // ───────────────────────────────────────────
  // Versioned lists. The version token is part of the key, so invalidating a
  // scope is one write. A reader that started before the invalidation writes
  // to the OLD key, which nobody reads any more, so it cannot resurrect stale
  // data. Old keys expire by TTL.
  // ───────────────────────────────────────────

  private async getVersion(scope: string): Promise<string | null> {
    try {
      return (await this.redis.getRawStrict(this.keys.version(scope))) ?? '0';
    } catch {
      return null;
    }
  }

  private async wrapScoped<T>(
    scope: string,
    build: (version: string) => string,
    factory: () => Promise<T>,
    ttl: number,
  ): Promise<T> {
    if (!(await this.canUseCache())) return factory();
    // FIX 3: a bump for this scope failed and is queued — bypass until the retry lands,
    // instead of serving/caching an entry that should already be gone.
    if (this.retryQueue.has(`scope:${scope}`)) return factory();
    const version = await this.getVersion(scope);
    if (version === null) return factory(); // Redis trouble: bypass, do not cache
    return this.wrap(build(version), factory, ttl);
  }

  // Legacy get()/set() over a versioned key.
  private async getScoped<T>(scope: string, build: (v: string) => string): Promise<T | null> {
    if (!(await this.canUseCache())) return null;
    // FIX 3
    if (this.retryQueue.has(`scope:${scope}`)) return null;
    const version = await this.getVersion(scope);
    if (version === null) return null;
    return this.read<T>(build(version));
  }

  private async setScoped(
    scope: string,
    build: (v: string) => string,
    data: unknown,
    ttl: number,
  ): Promise<void> {
    if (!(await this.canUseCache())) return;
    const version = await this.getVersion(scope);
    const s = this.redis.serialize(data);
    if (version === null || s === undefined) return;
    const r = await this.redis.evalScript<number>(
      SET_UNLESS_TOMBSTONE,
      [this.keys.tomb(scope), build(version)],
      [s, this.jitter(ttl)],
    );
    if (r === 0) this.stats.writesSkipped += 1;
  }

  private bumpScope(scope: string, extraDelete: string[] = []): Promise<void> {
    return this.guarded(`scope:${scope}`, async () => {
      const r = await this.redis.evalScript<number>(
        INVALIDATE,
        [this.keys.version(scope), this.keys.tomb(scope), ...extraDelete],
        // FIX 2: was `0` (no expiry) — every user/case scope's version key lived forever.
        // TTL.ENTITY_GEN (24h) is far above the longest entry lifetime (TAXONOMY 1800s +
        // STALE_GRACE), so it can never resurrect an old entry once it expires.
        [newToken(), TTL.TOMBSTONE, TTL.ENTITY_GEN],
      );
      return r === 1;
    });
  }

  // ───────────────────────────────────────────
  // Entities (details). Correct-by-construction path: wrapX() captures the
  // generation BEFORE reading the DB and writes back only if it is unchanged
  // (atomic in Lua). The old getX()/setX() pair keeps working: setX() is
  // blocked for TTL.TOMBSTONE seconds after an invalidation.
  // ───────────────────────────────────────────

  private async wrapEntity<T>(
    kind: string,
    id: string,
    key: string,
    factory: () => Promise<T>,
    ttl: number,
  ): Promise<T> {
    if (!(await this.canUseCache())) return factory();
    // FIX 3
    if (this.retryQueue.has(`entity:${kind}:${id}`)) return factory();

    const cached = await this.read<T>(key);
    if (cached !== null) return cached;

    const genKey = this.keys.gen(kind, id);
    let gen: string | null;
    try {
      gen = (await this.redis.getRawStrict(genKey)) ?? '0';
    } catch {
      gen = null;
    }
    if (gen === null) return factory(); // Redis trouble: serve, don't cache

    // FIX 1: the generation is captured BEFORE the factory runs and folded into the
    // single-flight key. Previously the flight was keyed by `key` alone and the generation
    // was read only inside it — a request starting AFTER a takedown could join a flight that
    // started BEFORE it and receive the pre-takedown row (the CAS below stopped it from being
    // re-cached, but not from being returned to that caller).
    return this.singleFlight(`${key}#${gen}`, async () => {
      const value = await factory();

      if (value !== null && value !== undefined) {
        const s = this.redis.serialize(value);
        if (s !== undefined) {
          const r = await this.redis.evalScript<number>(
            SET_IF_VERSION,
            [genKey, key],
            [gen as string, s, this.jitter(ttl)],
          );
          if (r === 0) this.stats.writesSkipped += 1;
        }
      }
      return value;
    });
  }

  private async setEntityLegacy(
    kind: string,
    id: string,
    key: string,
    data: unknown,
    ttl: number,
  ): Promise<void> {
    if (!(await this.canUseCache())) return;
    const s = this.redis.serialize(data);
    if (s === undefined) return;
    const r = await this.redis.evalScript<number>(
      SET_UNLESS_TOMBSTONE,
      [this.keys.tomb(`${kind}:${id}`), key],
      [s, this.jitter(ttl)],
    );
    if (r === 0) this.stats.writesSkipped += 1;
  }

  private invalidateEntity(
    kind: string,
    id: string,
    key: string,
    extraDelete: string[] = [],
  ): Promise<void> {
    return this.guarded(`entity:${kind}:${id}`, async () => {
      const r = await this.redis.evalScript<number>(
        INVALIDATE,
        [this.keys.gen(kind, id), this.keys.tomb(`${kind}:${id}`), key, ...extraDelete],
        [newToken(), TTL.TOMBSTONE, TTL.ENTITY_GEN],
      );
      return r === 1;
    });
  }

  private delKeys(id: string, ...keys: string[]): Promise<void> {
    return this.guarded(`del:${id}`, () => this.redis.del(...keys));
  }

  // ───────────────────────────────────────────
  // Invalidation retry. A failed invalidation is queued and replayed (every
  // couple of seconds and immediately on reconnect) instead of being logged
  // and forgotten. The queue is in memory: if the process dies during an
  // outage, stale entries are bounded by their TTL (at most ~5 min).
  // ───────────────────────────────────────────

  private async guarded(id: string, op: () => Promise<boolean>): Promise<void> {
    let ok = false;
    try {
      ok = await op();
    } catch {
      ok = false;
    }
    if (ok) {
      this.retryQueue.delete(id);
      return;
    }
    this.stats.invalidationFailures += 1;
    this.enqueue(id, op);
  }

  private enqueue(id: string, op: () => Promise<boolean>) {
    const existing = this.retryQueue.get(id);
    if (!existing && this.retryQueue.size >= RETRY_QUEUE_MAX) {
      // Too many to track: purge every cache namespace once Redis is back.
      this.needsPurge = true;
    } else {
      this.retryQueue.set(id, { op, firstAt: existing?.firstAt ?? Date.now() });
    }
    if (!this.retryTimer) {
      this.retryTimer = setInterval(() => void this.flushRetryQueue(), RETRY_INTERVAL_MS);
      this.retryTimer.unref?.();
    }
  }

  private async flushRetryQueue(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      const now = Date.now();
      for (const [id, item] of [...this.retryQueue]) {
        if (now - item.firstAt > RETRY_MAX_AGE_MS) {
          this.retryQueue.delete(id);
          this.stats.retryDropped += 1;
          continue;
        }
        let ok = false;
        try {
          ok = await item.op();
        } catch {
          ok = false;
        }
        if (ok) {
          this.retryQueue.delete(id);
          this.stats.retried += 1;
        } else if (!this.redis.isConnected) {
          break; // still down, try again next tick
        }
      }
      if (this.needsPurge && this.redis.isConnected && (await this.purgeAll())) {
        this.needsPurge = false;
      }
    } finally {
      this.flushing = false;
      if (!this.retryQueue.size && !this.needsPurge && this.retryTimer) {
        clearInterval(this.retryTimer);
        this.retryTimer = null;
      }
    }
  }

  /** Drops every cached value (not auth keys, not version/generation keys). Rare. */
  async purgeAll(): Promise<boolean> {
    const results = await Promise.all(
      this.keys.purgePatterns().map((p) => this.redis.delByPattern(p)),
    );
    return results.every(Boolean);
  }

  // ═══════════════════════════════════════════
  // AUTH / IDENTITY
  // ═══════════════════════════════════════════

  getProfile<T>(userId: string) {
    return this.read<T>(this.keys.profile(userId));
  }

  setProfile(userId: string, data: unknown) {
    return this.setEntityLegacy(
      'user-profile',
      userId,
      this.keys.profile(userId),
      data,
      TTL.PROFILE,
    );
  }

  wrapProfile<T>(userId: string, factory: () => Promise<T>) {
    return this.wrapEntity('user-profile', userId, this.keys.profile(userId), factory, TTL.PROFILE);
  }

  invalidateProfile(userId: string) {
    return this.invalidateEntity('user-profile', userId, this.keys.profile(userId));
  }

  getSession<T>(userId: string) {
    return this.read<T>(this.keys.session(userId));
  }

  setSession(userId: string, data: unknown) {
    return this.setEntityLegacy('session', userId, this.keys.session(userId), data, TTL.SESSION);
  }

  // Also blocks re-caching for a few seconds, so a request already in flight
  // cannot put a just-revoked session back.
  clearSession(userId: string) {
    return this.invalidateEntity('session', userId, this.keys.session(userId));
  }

  /**
   * Per-request session/role/permission check used by JwtStrategy. Keyed by
   * (userId, sessionId): each device/session gets its own entry, so rotating one
   * session's `sid` on /refresh can never read or clobber another device's cache.
   * Short TTL (TTL.SESSION_AUTH) rather than a generation — purgeUserCache() below
   * sweeps these on logout/reset/deactivate/role-change; the TTL just bounds the
   * window for any path that doesn't (yet) call purgeUserCache().
   */
  wrapSessionAuth<T>(userId: string, sessionId: string, factory: () => Promise<T>): Promise<T> {
    return this.wrap(this.keys.sessionAuth(userId, sessionId), factory, TTL.SESSION_AUTH);
  }

  // Failed-login counters use the SECURITY connection: losing one to cache
  // eviction would silently reset a lockout.
  incrementFailedLoginAttempts(identifier: string): Promise<number | null> {
    return this.sec.incrementWithTtl(
      this.keys.failedLoginAttempts(this.hashIdentifier(identifier)),
      TTL.FAILED_LOGIN_ATTEMPTS,
    );
  }

  // Returns null (not 0) when Redis is down, so callers must check Postgres instead.
  async getFailedLoginAttempts(identifier: string): Promise<number | null> {
    if (!this.sec.isConnected) return null;
    try {
      const raw = await this.sec.getRawStrict(
        this.keys.failedLoginAttempts(this.hashIdentifier(identifier)),
      );
      return raw ? parseInt(raw, 10) : 0;
    } catch {
      return null;
    }
  }

  // Retried until it succeeds: an unlock that is lost leaves the user locked.
  resetFailedLoginAttempts(identifier: string): Promise<void> {
    const key = this.keys.failedLoginAttempts(this.hashIdentifier(identifier));
    return this.guarded(`fl:${key}`, () => this.sec.del(key));
  }

  /** Fast-path read for OtpUtil's resend cooldown; see cache.keys.ts:otpCooldown. */
  async getOtpCooldown(userId: string, purpose: string, channel: string): Promise<string | null> {
    if (!this.sec.isConnected) return null;
    try {
      return await this.sec.getRawStrict(this.keys.otpCooldown(userId, purpose, channel));
    } catch {
      return null;
    }
  }

  setOtpCooldown(
    userId: string,
    purpose: string,
    channel: string,
    verificationId: string,
    ttlSeconds: number,
  ): Promise<void> {
    return this.sec.setRaw(this.keys.otpCooldown(userId, purpose, channel), verificationId, ttlSeconds);
  }

  // ── Re-auth gate: rate limiting for ReauthService, entirely on the security
  // connection, deliberately separate from the login counters above.
  //
  // Fails open if Redis is unreachable (same trade-off as every other failed-login
  // check in this file): a request already got past JwtAuthGuard to reach this gate,
  // so an outage here means "no extra brute-force limit on the sensitive action", not
  // "the account is unprotected" — bcrypt's own cost factor is still the floor.

  /** True only while a Redis-set lock is active. Never throws; unreachable Redis = not locked. */
  async isReauthLocked(userId: string): Promise<boolean> {
    if (!this.sec.isConnected) return false;
    try {
      return await this.sec.exists(this.keys.reauthLocked(this.hashIdentifier(userId)));
    } catch {
      return false;
    }
  }

  /**
   * Call after a failed verifyCredential(). Locks the gate once maxAttempts is hit and
   * resets the counter (mirrors LockoutUtil.recordFailedLogin, but Redis-only: there is no
   * Postgres column for this — the account itself isn't locked, only this gate).
   */
  async recordReauthFailure(userId: string, maxAttempts: number): Promise<void> {
    const hashed = this.hashIdentifier(userId);
    const attempts = await this.sec.incrementWithTtl(
      this.keys.reauthFailedAttempts(hashed),
      TTL.REAUTH_FAILED_ATTEMPTS,
    );
    if (attempts !== null && attempts >= maxAttempts) {
      await this.sec.setRaw(this.keys.reauthLocked(hashed), '1', TTL.REAUTH_LOCKOUT);
      await this.sec.del(this.keys.reauthFailedAttempts(hashed));
    }
  }

  /** Call after a successful verifyCredential(). */
  async resetReauthFailures(userId: string): Promise<void> {
    const hashed = this.hashIdentifier(userId);
    await this.sec.del(this.keys.reauthFailedAttempts(hashed), this.keys.reauthLocked(hashed));
  }

  // Password-reset state. The raw token never appears in a key name.
  setPasswordReset(token: string, data: unknown): Promise<boolean> {
    return this.sec.set(
      this.keys.passwordReset(this.hashSecret(token)),
      data,
      TTL.PASSWORD_RESET,
    );
  }

  getPasswordReset<T>(token: string): Promise<T | null> {
    return this.sec.get<T>(this.keys.passwordReset(this.hashSecret(token)));
  }

  /** Reads and deletes in one atomic step, so a token can be used only once. */
  async consumePasswordReset<T>(token: string): Promise<T | null> {
    const raw = await this.sec.getAndDelete(this.keys.passwordReset(this.hashSecret(token)));
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  deletePasswordReset(token: string): Promise<void> {
    const key = this.keys.passwordReset(this.hashSecret(token));
    return this.guarded(`pr:${key}`, () => this.sec.del(key));
  }

  // Deterministic keys + version bumps: no SCAN, except the session-auth sweep below
  // (bounded: at most one key per active session for this one user).
  async purgeUserCache(userId: string): Promise<void> {
    await Promise.all([
      this.invalidateProfile(userId),
      this.clearSession(userId),
      this.invalidateUnreadNotificationCount(userId),
      this.invalidateMyReports(userId),
      this.invalidateMyPosts(userId),
      this.invalidateNotifications(userId),
      // Drops every cached session-auth entry for this user (every device/session), so
      // logout, password reset/change, deactivation and role changes take effect on the
      // NEXT request instead of waiting out TTL.SESSION_AUTH.
      this.guarded(`session-auth:${userId}`, () =>
        this.redis.delByPattern(`${this.keys.prefix}user:${userId}:session:*:auth`),
      ),
    ]);
  }

  // ═══════════════════════════════════════════
  // REPORTS
  // ═══════════════════════════════════════════

  getReportStatus<T>(reportId: string) {
    return this.read<T>(this.keys.reportStatus(reportId));
  }

  setReportStatus(reportId: string, data: unknown) {
    return this.setEntityLegacy(
      'report-status',
      reportId,
      this.keys.reportStatus(reportId),
      data,
      TTL.REPORT_STATUS,
    );
  }

  invalidateReportStatus(reportId: string) {
    return this.invalidateEntity('report-status', reportId, this.keys.reportStatus(reportId));
  }

  getMyReports<T>(userId: string, page = 1) {
    return this.getScoped<T>(this.keys.scopes.userReports(userId), (v) =>
      this.keys.myReports(userId, v, page),
    );
  }

  setMyReports(userId: string, data: unknown, page = 1) {
    return this.setScoped(
      this.keys.scopes.userReports(userId),
      (v) => this.keys.myReports(userId, v, page),
      data,
      TTL.MY_REPORTS,
    );
  }

  wrapMyReports<T>(userId: string, page: number, factory: () => Promise<T>) {
    return this.wrapScoped(
      this.keys.scopes.userReports(userId),
      (v) => this.keys.myReports(userId, v, page),
      factory,
      TTL.MY_REPORTS,
    );
  }

  invalidateMyReports(userId: string) {
    return this.bumpScope(this.keys.scopes.userReports(userId));
  }

  // ═══════════════════════════════════════════
  // POSTS
  // ═══════════════════════════════════════════

  getPost<T>(postId: string) {
    return this.read<T>(this.keys.post(postId));
  }

  /** Safe against a takedown racing the read: blocked briefly after an invalidation. */
  setPost(postId: string, data: unknown) {
    return this.setEntityLegacy('post', postId, this.keys.post(postId), data, TTL.POST_DETAIL);
  }

  /** Preferred: read-through with an exact stale-write guard. */
  wrapPost<T>(postId: string, factory: () => Promise<T>) {
    return this.wrapEntity('post', postId, this.keys.post(postId), factory, TTL.POST_DETAIL);
  }

  invalidatePost(postId: string) {
    return this.invalidateEntity('post', postId, this.keys.post(postId));
  }

  wrapPostList<T>(query: Record<string, unknown>, factory: () => Promise<T>): Promise<T> {
    const { hash, cacheable } = this.listCacheKey(query, LIST_QUERY_FIELDS.post);
    if (!cacheable) return factory();
    return this.wrapScoped(
      this.keys.scopes.postList(),
      (v) => this.keys.postList(v, hash),
      factory,
      TTL.POST_LIST,
    );
  }

  invalidatePostLists() {
    return this.bumpScope(this.keys.scopes.postList());
  }

  // Call on approve, reject, edit, unpublish or takedown.
  async invalidatePostEverywhere(postId: string): Promise<void> {
    await Promise.all([this.invalidatePost(postId), this.invalidatePostLists()]);
  }

  getMyPosts<T>(userId: string, page = 1) {
    return this.getScoped<T>(this.keys.scopes.userPosts(userId), (v) =>
      this.keys.myPosts(userId, v, page),
    );
  }

  setMyPosts(userId: string, data: unknown, page = 1) {
    return this.setScoped(
      this.keys.scopes.userPosts(userId),
      (v) => this.keys.myPosts(userId, v, page),
      data,
      TTL.MY_POSTS,
    );
  }

  wrapMyPosts<T>(userId: string, page: number, factory: () => Promise<T>) {
    return this.wrapScoped(
      this.keys.scopes.userPosts(userId),
      (v) => this.keys.myPosts(userId, v, page),
      factory,
      TTL.MY_POSTS,
    );
  }

  invalidateMyPosts(userId: string) {
    return this.bumpScope(this.keys.scopes.userPosts(userId));
  }

  async getPendingPostsCount(): Promise<number | null> {
    const raw = await this.readRaw(this.keys.pendingPostsCount());
    return raw === null ? null : parseInt(raw, 10);
  }

  setPendingPostsCount(count: number) {
    return this.writeRaw(this.keys.pendingPostsCount(), String(count), TTL.PENDING_POSTS_COUNT);
  }

  invalidatePendingPostsCount() {
    return this.delKeys('pending-posts-count', this.keys.pendingPostsCount());
  }

  // ═══════════════════════════════════════════
  // MISSING PERSONS
  // ═══════════════════════════════════════════

  getMissingPerson<T>(id: string) {
    return this.read<T>(this.keys.missingPerson(id));
  }

  setMissingPerson(id: string, data: unknown) {
    return this.setEntityLegacy(
      'missing-person',
      id,
      this.keys.missingPerson(id),
      data,
      TTL.MISSING_PERSON_DETAIL,
    );
  }

  wrapMissingPerson<T>(id: string, factory: () => Promise<T>) {
    return this.wrapEntity(
      'missing-person',
      id,
      this.keys.missingPerson(id),
      factory,
      TTL.MISSING_PERSON_DETAIL,
    );
  }

  invalidateMissingPerson(id: string) {
    return this.invalidateEntity('missing-person', id, this.keys.missingPerson(id));
  }

  wrapMissingPersonList<T>(query: Record<string, unknown>, factory: () => Promise<T>): Promise<T> {
    const { hash, cacheable } = this.listCacheKey(query, LIST_QUERY_FIELDS['missing-person']);
    if (!cacheable) return factory();
    return this.wrapScoped(
      this.keys.scopes.missingPersonList(),
      (v) => this.keys.missingPersonList(v, hash),
      factory,
      TTL.MISSING_PERSON_LIST,
    );
  }

  getApprovedMissingPersons<T>(page = 1) {
    return this.getScoped<T>(this.keys.scopes.missingPersonList(), (v) =>
      this.keys.approvedMissingPersons(v, page),
    );
  }

  setApprovedMissingPersons(data: unknown, page = 1) {
    return this.setScoped(
      this.keys.scopes.missingPersonList(),
      (v) => this.keys.approvedMissingPersons(v, page),
      data,
      TTL.APPROVED_MISSING_PERSONS,
    );
  }

  // Covers the plain lists AND the approved lists (same scope).
  invalidateMissingPersonCaches() {
    return this.bumpScope(this.keys.scopes.missingPersonList());
  }

  // Call on approve, reject, edit, unpublish or takedown. Also clears the
  // case's tips list (it belongs to the case and should follow its status).
  async invalidateMissingPersonEverywhere(id: string): Promise<void> {
    await Promise.all([
      this.invalidateMissingPerson(id),
      this.invalidateMissingPersonCaches(),
      this.invalidateInformationSubmissionList(id),
    ]);
  }

  // ───────────────────────────────────────────
  // INFORMATION SUBMISSION
  // Lists are scoped per missing-person case, not global.
  // ───────────────────────────────────────────

  wrapInformationSubmissionList<T>(
    missingPersonId: string,
    query: Record<string, unknown>,
    factory: () => Promise<T>,
  ): Promise<T> {
    const { hash, cacheable } = this.listCacheKey(
      query,
      LIST_QUERY_FIELDS['information-submission'],
    );
    if (!cacheable) return factory();
    return this.wrapScoped(
      this.keys.scopes.informationSubmission(missingPersonId),
      (v) => this.keys.informationSubmissionList(missingPersonId, v, hash),
      factory,
      TTL.INFORMATION_SUBMISSION_LIST,
    );
  }

  invalidateInformationSubmissionList(missingPersonId: string) {
    return this.bumpScope(this.keys.scopes.informationSubmission(missingPersonId));
  }

  // ═══════════════════════════════════════════
  // VICTIM PROFILES
  // ═══════════════════════════════════════════

  getVictimProfile<T>(id: string) {
    return this.read<T>(this.keys.victimProfile(id));
  }

  setVictimProfile(id: string, data: unknown) {
    return this.setEntityLegacy(
      'victim-profile',
      id,
      this.keys.victimProfile(id),
      data,
      TTL.VICTIM_PROFILE_DETAIL,
    );
  }

  wrapVictimProfile<T>(id: string, factory: () => Promise<T>) {
    return this.wrapEntity(
      'victim-profile',
      id,
      this.keys.victimProfile(id),
      factory,
      TTL.VICTIM_PROFILE_DETAIL,
    );
  }

  invalidateVictimProfile(id: string) {
    return this.invalidateEntity('victim-profile', id, this.keys.victimProfile(id));
  }

  wrapVictimProfileList<T>(query: Record<string, unknown>, factory: () => Promise<T>): Promise<T> {
    // Free-text searches are long-tail: near-zero hit rate, unbounded key space. Never cache them.
    const search = typeof query?.search === 'string' ? query.search.trim() : '';
    if (search !== '') return factory();
    const { hash, cacheable } = this.listCacheKey(query, LIST_QUERY_FIELDS['victim-profile']);
    if (!cacheable) return factory();
    return this.wrapScoped(
      this.keys.scopes.victimProfileList(),
      (v) => this.keys.victimProfileList(v, hash),
      factory,
      TTL.VICTIM_PROFILE_LIST,
    );
  }

  getApprovedVictimProfiles<T>(page = 1) {
    return this.getScoped<T>(this.keys.scopes.victimProfileList(), (v) =>
      this.keys.approvedVictimProfiles(v, page),
    );
  }

  setApprovedVictimProfiles(data: unknown, page = 1) {
    return this.setScoped(
      this.keys.scopes.victimProfileList(),
      (v) => this.keys.approvedVictimProfiles(v, page),
      data,
      TTL.APPROVED_VICTIM_PROFILES,
    );
  }

  invalidateApprovedVictimProfiles() {
    return this.bumpScope(this.keys.scopes.victimProfileList());
  }

  // Call on approve, reject, edit, unpublish, takedown AND on every confirmed
  // support (totalRaised changes). Also clears the public stats.
  async invalidateVictimProfileEverywhere(id: string): Promise<void> {
    await Promise.all([
      this.invalidateVictimProfile(id),
      this.invalidateApprovedVictimProfiles(),
      this.invalidateStats('victim-profile-public'),
    ]);
  }

  // ═══════════════════════════════════════════
  // NOTIFICATIONS
  // ═══════════════════════════════════════════

  getNotifications<T>(userId: string, page = 1) {
    return this.getScoped<T>(this.keys.scopes.userNotifications(userId), (v) =>
      this.keys.notifications(userId, v, page),
    );
  }

  setNotifications(userId: string, data: unknown, page = 1) {
    return this.setScoped(
      this.keys.scopes.userNotifications(userId),
      (v) => this.keys.notifications(userId, v, page),
      data,
      TTL.NOTIFICATIONS,
    );
  }

  wrapNotifications<T>(userId: string, page: number, factory: () => Promise<T>) {
    return this.wrapScoped(
      this.keys.scopes.userNotifications(userId),
      (v) => this.keys.notifications(userId, v, page),
      factory,
      TTL.NOTIFICATIONS,
    );
  }

  invalidateNotifications(userId: string) {
    return this.bumpScope(this.keys.scopes.userNotifications(userId));
  }

  async getUnreadNotificationCount(userId: string): Promise<number | null> {
    const raw = await this.readRaw(this.keys.unreadNotificationCount(userId));
    return raw === null ? null : parseInt(raw, 10);
  }

  setUnreadNotificationCount(userId: string, count: number) {
    return this.writeRaw(
      this.keys.unreadNotificationCount(userId),
      String(count),
      TTL.UNREAD_NOTIFICATION_COUNT,
    );
  }

  invalidateUnreadNotificationCount(userId: string) {
    return this.delKeys(`unread:${userId}`, this.keys.unreadNotificationCount(userId));
  }

  // ═══════════════════════════════════════════
  // TAXONOMIES
  // ═══════════════════════════════════════════

  getIncidentCategories<T>() {
    return this.read<T>(this.keys.incidentCategories());
  }

  setIncidentCategories(data: unknown) {
    return this.write(this.keys.incidentCategories(), data, TTL.TAXONOMY);
  }

  invalidateIncidentCategories() {
    return this.delKeys('incident-categories', this.keys.incidentCategories());
  }

  getSupportCategories<T>() {
    return this.read<T>(this.keys.supportCategories());
  }

  setSupportCategories(data: unknown) {
    return this.write(this.keys.supportCategories(), data, TTL.TAXONOMY);
  }

  invalidateSupportCategories() {
    return this.delKeys('support-categories', this.keys.supportCategories());
  }

  // ═══════════════════════════════════════════
  // STATS (heavy aggregate queries)
  // ═══════════════════════════════════════════

  /**
   * Generic cached stats, e.g. wrapStats('post-admin', () => this.getStatsUncached()).
   * Suggested names: 'post-admin', 'missing-person-admin', 'report-admin',
   * 'user-dashboard', 'victim-profile-admin', 'victim-profile-public'.
   */
  wrapStats<T>(name: string, factory: () => Promise<T>, ttlSeconds: number = TTL.STATS) {
    return this.wrap(this.keys.stats(name), factory, ttlSeconds);
  }

  invalidateStats(name: string) {
    return this.delKeys(`stats:${name}`, this.keys.stats(name));
  }

  wrapAdminDashboardStats<T>(factory: () => Promise<T>): Promise<T> {
    return this.wrap(this.keys.adminDashboardStats(), factory, TTL.ADMIN_DASHBOARD_STATS);
  }

  invalidateAdminDashboardStats() {
    return this.delKeys('admin-dashboard-stats', this.keys.adminDashboardStats());
  }
}