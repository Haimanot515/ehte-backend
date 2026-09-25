// src/services/redis/cache.keys.ts
// Cache status/metadata, never raw report/evidence bodies.
// Hash identifiers (emails, phones, tokens), never put raw ones in a key.
//
// Key families:
//   <entity>          cached value (post, missing person, victim profile, ...)
//   ver:<scope>       list "version token". Lists embed the token in their key,
//                     so invalidating every list in a scope is ONE write
//                     (no SCAN sweeps, no race with in-flight readers).
//   gen:<kind>:<id>   per-entity generation. A reader may only write back if
//                     the generation is unchanged since it started reading
//                     (fixes stale write-back after a takedown).
//   tomb:<scope>      short-lived marker written on invalidation; blocks
//                     write-backs from callers that use the older get()/set()
//                     accessors (which cannot carry a generation).

export function buildCacheKeys(prefix = 'ehte:') {
  const p = prefix;

  return {
    prefix: p,

    cacheEnabled: () => `${p}cache:enabled`,
    version: (scope: string) => `${p}ver:${scope}`,
    tomb: (scope: string) => `${p}tomb:${scope}`,
    gen: (kind: string, id: string) => `${p}gen:${kind}:${id}`,

    // Scope names shared by version / tomb keys.
    scopes: {
      postList: () => 'post-list',
      missingPersonList: () => 'missing-person-list',
      victimProfileList: () => 'victim-profile-list',
      informationSubmission: (missingPersonId: string) =>
        `information-submission:${missingPersonId}`,
      userReports: (userId: string) => `user:${userId}:reports`,
      userPosts: (userId: string) => `user:${userId}:posts`,
      userNotifications: (userId: string) => `user:${userId}:notifications`,
    },

    // ── auth / identity ───────────────────────────────────────
    profile: (userId: string) => `${p}user:${userId}:profile`,
    session: (userId: string) => `${p}user:${userId}:session`,
    // Per-session roles/permissions/alive-state, keyed by (userId, sessionId) so
    // rotating one device's session (a new `sid` on /refresh) can never read or
    // clobber another device's cached auth state. Checked on every authenticated
    // request by JwtStrategy — short TTL (TTL.SESSION_AUTH), not a generation:
    // purgeUserCache() sweeps these on logout/reset/deactivate/role-change, and
    // the TTL bounds the window for anything that doesn't.
    sessionAuth: (userId: string, sessionId: string) =>
      `${p}user:${userId}:session:${sessionId}:auth`,
    // Callers pass an already-hashed identifier / token (CacheService hashes).
    failedLoginAttempts: (hashedIdentifier: string) =>
      `${p}auth:failed-attempts:${hashedIdentifier}`,
    // Anti-spam cooldown for OTP resend, keyed by (user, purpose, channel). Value is the
    // still-valid verificationId, so a repeat "resend" click returns it without a Postgres
    // read. Not security-critical the way lockout counters are (a miss just means one extra
    // Postgres check, never a bypassed limit — Postgres re-checks the cooldown itself), but
    // it lives on the security connection anyway since it's the same anti-abuse family.
    otpCooldown: (userId: string, purpose: string, channel: string) =>
      `${p}auth:otp-cooldown:${userId}:${purpose}:${channel}`,
    // Re-auth gate (ReauthGuard/ReauthService): separate counter and lock from
    // failedLoginAttempts above — a session that's already authenticated failing its
    // re-auth check (wrong password/passcode on a sensitive action) is a different signal
    // from a failed LOGIN, and must not share a key with it or inflate/trigger the other.
    reauthFailedAttempts: (hashedUserId: string) =>
      `${p}auth:reauth-failed-attempts:${hashedUserId}`,
    reauthLocked: (hashedUserId: string) => `${p}auth:reauth-locked:${hashedUserId}`,
    passwordReset: (hashedToken: string) => `${p}auth:pwd-reset:${hashedToken}`,

    // ── reports ───────────────────────────────────────────────
    reportStatus: (reportId: string) => `${p}report:${reportId}:status`,
    myReports: (userId: string, version: string, page = 1) =>
      `${p}user:${userId}:reports:${version}:${page}`,

    // ── posts ─────────────────────────────────────────────────
    post: (postId: string) => `${p}post:${postId}`,
    postList: (version: string, queryHash: string) => `${p}post:list:${version}:${queryHash}`,
    myPosts: (userId: string, version: string, page = 1) =>
      `${p}user:${userId}:posts:${version}:${page}`,
    pendingPostsCount: () => `${p}posts:pending-count`,

    // ── missing persons ───────────────────────────────────────
    missingPerson: (id: string) => `${p}missing-person:${id}`,
    missingPersonList: (version: string, queryHash: string) =>
      `${p}missing-person:list:${version}:${queryHash}`,
    approvedMissingPersons: (version: string, page = 1) =>
      `${p}missing-person:approved:${version}:${page}`,

    // Scoped per missing-person case.
    informationSubmissionList: (missingPersonId: string, version: string, queryHash: string) =>
      `${p}information-submission:list:${missingPersonId}:${version}:${queryHash}`,

    // ── victim profiles ───────────────────────────────────────
    victimProfile: (id: string) => `${p}victim-profile:${id}`,
    victimProfileList: (version: string, queryHash: string) =>
      `${p}victim-profile:list:${version}:${queryHash}`,
    approvedVictimProfiles: (version: string, page = 1) =>
      `${p}victim-profile:approved:${version}:${page}`,

    // ── notifications ─────────────────────────────────────────
    notifications: (userId: string, version: string, page = 1) =>
      `${p}user:${userId}:notifications:${version}:${page}`,
    unreadNotificationCount: (userId: string) => `${p}user:${userId}:notifications:unread-count`,

    // ── taxonomies / stats ────────────────────────────────────
    incidentCategories: () => `${p}taxonomy:incident-categories`,
    supportCategories: () => `${p}taxonomy:support-categories`,
    adminDashboardStats: () => `${p}admin:dashboard-stats`,
    stats: (name: string) => `${p}stats:${name}`,

    // Only used by CacheService.purgeAll() (rare: after a long Redis outage that
    // overflowed the retry queue). Deliberately excludes auth:*, ver:*, gen:*.
    purgePatterns: () =>
      [
        'post:*',
        'posts:*',
        'missing-person:*',
        'victim-profile:*',
        'information-submission:*',
        'report:*',
        'taxonomy:*',
        'admin:*',
        'stats:*',
        'user:*',
      ].map((x) => `${p}${x}`),
  };
}

export type CacheKeyBuilder = ReturnType<typeof buildCacheKeys>;

// Default-prefix instance, kept for anything that imported CacheKeys directly.
// CacheService builds its own from `redis.keyPrefix`.
export const CacheKeys = buildCacheKeys('ehte:');

export const TTL = {
  SESSION: 900,
  PROFILE: 300,
  SESSION_AUTH: 30, // how long a session's roles/permissions/alive-state are trusted
  FAILED_LOGIN_ATTEMPTS: 900,
  REAUTH_FAILED_ATTEMPTS: 900, // counting window for wrong re-auth credentials
  REAUTH_LOCKOUT: 900, // how long the re-auth gate is blocked once the limit is hit
  PASSWORD_RESET: 600,

  REPORT_STATUS: 60,
  MY_REPORTS: 60,

  POST_DETAIL: 300,
  POST_LIST: 60,
  MY_POSTS: 60,
  PENDING_POSTS_COUNT: 30,

  MISSING_PERSON_DETAIL: 300,
  MISSING_PERSON_LIST: 120,
  APPROVED_MISSING_PERSONS: 120,

  INFORMATION_SUBMISSION_LIST: 120,

  VICTIM_PROFILE_DETAIL: 300,
  VICTIM_PROFILE_LIST: 120,
  APPROVED_VICTIM_PROFILES: 120,

  NOTIFICATIONS: 30,
  UNREAD_NOTIFICATION_COUNT: 15,

  TAXONOMY: 1800,

  ADMIN_DASHBOARD_STATS: 60,
  STATS: 60,

  // Cache-internal
  TOMBSTONE: 10, // how long an invalidation blocks legacy set() write-backs
  ENTITY_GEN: 86_400, // per-entity generation key lifetime
  STALE_GRACE: 30, // max extra seconds an expired list may be served while refreshing
} as const;