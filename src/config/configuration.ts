const nodeEnv = process.env.NODE_ENV || 'development';

// Key prefix so dev/staging/prod can share one Redis without colliding.
// Production keeps the historical 'ehte:' prefix so existing keys stay valid.
// NOTE: only takes effect once cache.keys.ts and redis-throttler.storage.ts
// build their keys from this value (both still hard-code 'ehte:').
const redisKeyPrefix =
  process.env.REDIS_KEY_PREFIX ?? (nodeEnv === 'production' ? 'ehte:' : `ehte:${nodeEnv}:`);

export default () => ({
  app: {
    name: process.env.APP_NAME || 'Ehte',
    env: nodeEnv,
    port: Number(process.env.PORT) || 3000,

    // Public URL of this API deployment (Swagger, EmailTemplateService links).
    // Falls back to localhost when APP_URL is unset.
    url: process.env.APP_URL || `http://localhost:${Number(process.env.PORT) || 3000}`,

    // Public URL of the admin web client, used for invite and promotion links.
    // Falls back to APP_URL, then localhost.
    adminUrl:
      process.env.ADMIN_APP_URL ||
      process.env.APP_URL ||
      `http://localhost:${Number(process.env.PORT) || 3000}`,

    // Enables dev-only OTP console logging. MUST be false in production.
    debug: process.env.APP_DEBUG === 'true',
  },

  sms: {
    afroMessage: {
      apiUrl: process.env.AFROMESSAGE_URL,
      apiKey: process.env.AFROMESSAGE_TOKEN,
      senderName: process.env.AFROMESSAGE_SENDER_NAME || 'Ehte',
      identifierId: process.env.AFROMESSAGE_IDENTIFIER_ID,
    },

    // SendET provider config, read by SendetService. Coexists with afroMessage
    // until cutover; sendSms() still throws until the API contract is confirmed.
    sendet: {
      apiUrl: process.env.SENDET_URL,
      token: process.env.SENDET_TOKEN,
      senderName: process.env.SENDET_SENDER_NAME || 'PITRON TECH',
      timeoutMs: parseInt(process.env.SENDET_TIMEOUT_MS ?? '10000', 10),
    },
  },

  // Read by FirebaseService via ConfigService, not process.env directly.
  // All three optional — PUSH delivery just stays disabled when unset.
  // FIREBASE_PRIVATE_KEY arrives with literal \n sequences (how it's stored
  // in .env / most secret managers) — unescape here, once, at the source.
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
  },

  database: {
    url: process.env.DATABASE_URL,
  },

  jwt: {
    secret: process.env.JWT_SECRET,

    // Default aligned with the Joi default in app.module.ts (was '1d' here,
    // '15m' there — this file wins at runtime because it reads process.env
    // directly). Anything deriving a session cache TTL from this value should
    // use the same number.
    expiresIn: process.env.JWT_EXPIRES_IN || '15m',

    // Without this mapping, refresh lookups silently fell back to jwt.secret.
    refreshSecret: process.env.JWT_REFRESH_SECRET,

    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  // Social login — one block per provider, all read only by SocialAuthUtil
  // (src/common/utils/social-auth.util.ts). Each ID token / access token is
  // verified against these values server-side; nothing here is optional at
  // runtime for a provider you actually enable — getOrThrow() is used for
  // all three in SocialAuthUtil, so an unset value fails loudly on first use
  // rather than silently accepting an unverifiable token.
  google: {
    // OAuth 2.0 Client ID from Google Cloud Console. If the web and mobile
    // clients use DIFFERENT client IDs, SocialAuthUtil.verifyGoogleIdToken()
    // will need to accept an array here instead of a single string — it
    // currently does not.
    clientId: process.env.GOOGLE_CLIENT_ID,
  },

  facebook: {
    appId: process.env.FACEBOOK_APP_ID,
    appSecret: process.env.FACEBOOK_APP_SECRET,
  },

  apple: {
    // Services ID (web/Android) or app bundle ID (native iOS) — whichever
    // audience your client's Sign in with Apple flow actually uses.
    clientId: process.env.APPLE_CLIENT_ID,
  },

  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: process.env.CORS_CREDENTIALS === 'true',
  },

  // Swagger is off by default; enable with SWAGGER_ENABLED=true.
  swagger: {
    enabled: process.env.SWAGGER_ENABLED === 'true',
  },

  // No reader found in the files reviewed (the throttler is configured from
  // THROTTLE_TTL_SECONDS / THROTTLE_LIMIT in app.module.ts). Grep for
  // 'rateLimit.' before deleting; kept so nothing else breaks.
  rateLimit: {
    ttl: parseInt(process.env.RATE_LIMIT_TTL ?? '60', 10),
    limit: parseInt(process.env.RATE_LIMIT_LIMIT ?? '100', 10),
  },

  otp: {
    expiresInMinutes: parseInt(process.env.OTP_EXPIRES_IN_MINUTES ?? '10', 10),

    // Minimum gap between OTP resends, enforced in AuthService.issueAndSendOtp().
    resendCooldownSeconds: parseInt(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? '60', 10),

    // Max failed verify attempts before lockout, enforced in AuthService
    // (verifySignupOtp, resetPassword, changePasswordVerify).
    maxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS ?? '5', 10),
  },

  minio: {
    // Production: the S3-compatible provider endpoint. Local: minio.
    endpoint: process.env.MINIO_ENDPOINT || 'localhost',

    // Production: 443. Local: 9000.
    port: Number(process.env.MINIO_PORT || 9000),

    accessKey: process.env.MINIO_ACCESS_KEY,

    secretKey: process.env.MINIO_SECRET_KEY,

    // Default matches the real bucket name, 'ehte-media'.
    bucketName: process.env.MINIO_BUCKET_NAME || 'ehte-media',

    // Production: true (HTTPS). Local: false.
    useSSL: process.env.MINIO_USE_SSL === 'true',

    // Some providers need an explicit region (e.g. 'auto' for Cloudflare R2).
    region: process.env.MINIO_REGION || 'us-east-1',

    // Presigned URL lifetime; short so a leaked URL stops working quickly.
    presignDurationSeconds: parseInt(process.env.DURATION_OF_PRE_SIGNED_DOCUMENT ?? '600', 10),
  },

  // Mirrors the REDIS_* vars RedisService reads. REDIS_URL wins over host/port.
  redis: {
    url: process.env.REDIS_URL,
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD,
    db: parseInt(process.env.REDIS_DB ?? '0', 10),

    // TLS is selected by the rediss:// scheme in REDIS_URL (ioredis enables it
    // automatically). Host/port mode has no TLS support in RedisService.
    tls: (process.env.REDIS_URL ?? '').startsWith('rediss://'),

    // Production refuses to boot without TLS + password unless this is true
    // (see app.module.ts). Only for Redis on a trusted private network.
    allowInsecure: process.env.REDIS_ALLOW_INSECURE === 'true',

    // Separate instance for throttle counters, login lockout counters and
    // reset keys, so an evicting cache can't drop them. Unset = same Redis
    // as the cache. Read by SecurityRedisService (redis.module.ts).
    securityUrl: process.env.REDIS_SECURITY_URL,

    keyPrefix: redisKeyPrefix,
  },

  security: {
    // Login lockout, enforced in AuthService for login() and adminLogin().
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS ?? '5', 10),

    lockoutDurationMinutes: parseInt(process.env.LOCKOUT_DURATION_MINUTES ?? '15', 10),

    // Password hashing cost. OTP hashing uses its own, higher-cost setting below.
    bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS ?? '10', 10),

    // OTP hashing cost, used only in AuthService.signup() when hashing the OTP.
    bcryptOtpSaltRounds: parseInt(process.env.BCRYPT_OTP_SALT_ROUNDS ?? '12', 10),
  },

  // Fallbacks kept in sync with the Joi defaults in app.module.ts.
  media: {
    maxFileSize: parseInt(process.env.MEDIA_MAX_FILE_SIZE ?? '52428800', 10),

    allowedMimeTypes:
      process.env.MEDIA_ALLOWED_MIME_TYPES ||
      'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp4,application/pdf',
  },

  // content.* is not namespaced: services read CONTENT_*, POST_*, REPORT_*,
  // MISSING_PERSON_* and PROFILE_* env vars directly (declared in app.module.ts).

  support: {
    currency: process.env.SUPPORT_CURRENCY || 'ETB',

    enabled: process.env.SUPPORT_ENABLED !== 'false',
  },

  missingPersons: {
    enabled: process.env.MISSING_PERSONS_ENABLED !== 'false',
  },

  victimSupport: {
    enabled: process.env.VICTIM_SUPPORT_ENABLED !== 'false',
  },

  payments: {
    enabled: process.env.PAYMENTS_ENABLED === 'true',
    rewardsEnabled: process.env.PAYMENTS_REWARDS_ENABLED === 'true',
    returnUrl: process.env.PAYMENTS_RETURN_URL || '',
    minSupportEtb: process.env.PAYMENTS_MIN_SUPPORT_ETB || '10',

    // Window within which a repeat checkout/funding attempt on the same
    // target is treated as a duplicate, in PaymentService.initiateSupportCheckout()
    // and initiateRewardFunding().
    duplicateWindowMinutes: parseInt(process.env.PAYMENT_DUPLICATE_WINDOW_MINUTES ?? '30', 10),

    // Age past which a still-PENDING payment is considered stale by
    // PaymentService.reconcileStale().
    staleAfterMinutes: parseInt(process.env.PAYMENT_STALE_AFTER_MINUTES ?? '15', 10),

    // Age past which a stale payment is treated as expired (also
    // reconcileStale()).
    expiryHours: parseInt(process.env.PAYMENT_EXPIRY_HOURS ?? '24', 10),

    // Age band PaymentService.repairUnconfirmedSupports() operates within:
    // only attempts a repair once a paidAt is at least minAgeMinutes old,
    // and gives up once it's older than maxAgeDays.
    repair: {
      minAgeMinutes: parseInt(process.env.PAYMENT_REPAIR_MIN_AGE_MINUTES ?? '2', 10),
      maxAgeDays: parseInt(process.env.PAYMENT_REPAIR_MAX_AGE_DAYS ?? '7', 10),
    },

    // Intended cadence for both reconcileStale() and repairUnconfirmedSupports().
    // Both are currently static @Cron(CronExpression.EVERY_10_MINUTES) decorators,
    // so this value is not yet actually read by the schedule — it documents the
    // intended interval pending a SchedulerRegistry.addCronJob() refactor.
    reconcileIntervalMinutes: parseInt(
      process.env.PAYMENT_RECONCILE_INTERVAL_MINUTES ?? '10',
      10,
    ),
  },

  // How long a Chapa transfer disbursement may sit in PROCESSING before
  // DisbursementService.syncProcessing() flags it via a SECURITY_ALERT
  // audit event. Does not cancel or retry anything by itself.
  disbursement: {
    processingTimeoutMinutes: parseInt(
      process.env.DISBURSEMENT_PROCESSING_TIMEOUT_MINUTES ?? '60',
      10,
    ),
  },

  chapa: {
    secretKey: process.env.CHAPA_SECRET_KEY,
    webhookSecret: process.env.CHAPA_WEBHOOK_SECRET,
    baseUrl: process.env.CHAPA_BASE_URL || 'https://api.chapa.co/v1',
    fallbackEmail: process.env.CHAPA_FALLBACK_EMAIL,

    // Request timeout and checkout field length caps, read by ChapaService.
    timeoutMs: parseInt(process.env.CHAPA_TIMEOUT_MS ?? '15000', 10),
    titleMaxLength: parseInt(process.env.CHAPA_TITLE_MAX_LENGTH ?? '16', 10),
    descriptionMaxLength: parseInt(process.env.CHAPA_DESCRIPTION_MAX_LENGTH ?? '50', 10),
  },
});