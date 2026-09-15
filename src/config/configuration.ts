export default () => ({
  app: {
    name: process.env.APP_NAME || 'Ehte',
    env: process.env.NODE_ENV || 'development',
    port: Number(process.env.PORT) || 3000,

    // Public URL of this deployment (e.g. https://ehte-api.onrender.com).
    // Same value main.ts reads directly via configService.get('APP_URL')
    // for Swagger's server list. Mapped here too so namespaced lookups
    // like configService.get('app.url') — used in EmailTemplateService
    // for building admin invite links — resolve to the real domain
    // instead of always falling back to their hardcoded default.
    url: process.env.APP_URL || `http://localhost:${Number(process.env.PORT) || 3000}`,

    // Public URL of the ADMIN-facing web client (e.g. https://admin.ehte.org),
    // as opposed to `url` above which is this API's own deployment / the main
    // user-facing app. Used by AuthService.adminInvite() / adminInviteResend()
    // / promoteUserInitiate() / promoteUserResend() to build invite and
    // promotion links that land on the admin site's /admin/invite and
    // /admin/promote/verify routes, not the main app. Falls back to `url` so
    // this is non-breaking if ADMIN_APP_URL is never set (e.g. single-client
    // deployments where the admin panel and main app share one domain).
    adminUrl:
      process.env.ADMIN_APP_URL ||
      process.env.APP_URL ||
      `http://localhost:${Number(process.env.PORT) || 3000}`,

    // Gates dev-only OTP console logging in AuthService. MUST be false
    // in production — leaving it true prints real OTPs to server logs.
    debug: process.env.APP_DEBUG === 'true',
  },

  sms: {
    afroMessage: {
      apiUrl: process.env.AFROMESSAGE_URL,
      apiKey: process.env.AFROMESSAGE_TOKEN,
      senderName: process.env.AFROMESSAGE_SENDER_NAME || 'Ehte',
      identifierId: process.env.AFROMESSAGE_IDENTIFIER_ID,
    },
  },

  database: {
    url: process.env.DATABASE_URL,
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',

    // FIX: was previously unmapped — every refreshSecret lookup in
    // AuthService silently fell back to jwt.secret regardless of
    // whether JWT_REFRESH_SECRET was set in the environment.
    refreshSecret: process.env.JWT_REFRESH_SECRET,

    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: process.env.CORS_CREDENTIALS === 'true',
  },

  // Swagger is OFF by default.
  // Enable explicitly with:
  // SWAGGER_ENABLED=true
  swagger: {
    enabled: process.env.SWAGGER_ENABLED === 'true',
  },

  rateLimit: {
    ttl: parseInt(process.env.RATE_LIMIT_TTL ?? '60', 10),
    limit: parseInt(process.env.RATE_LIMIT_LIMIT ?? '100', 10),
  },

  otp: {
    expiresInMinutes: parseInt(process.env.OTP_EXPIRES_IN_MINUTES ?? '10', 10),

    // Minimum time between OTP resends for the same purpose/user,
    // enforced in AuthService.issueAndSendOtp().
    resendCooldownSeconds: parseInt(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? '60', 10),
  },

  minio: {
    // Production (Render -> Cloudflare R2 / Backblaze B2): the provider's
    // S3-compatible endpoint. Local (Docker Compose -> MinIO): minio
    endpoint: process.env.MINIO_ENDPOINT || 'localhost',

    // Production: 443 (HTTPS). Local: 9000 (MinIO's default).
    port: Number(process.env.MINIO_PORT || 9000),

    accessKey: process.env.MINIO_ACCESS_KEY,

    secretKey: process.env.MINIO_SECRET_KEY,

    // FIX: default was 'ehte', but the actual bucket — both the local MinIO
    // bucket and the one already created with the storage provider — is
    // 'ehte-media'. This only matters when MINIO_BUCKET_NAME is unset, but
    // it was wrong and would silently point at a bucket that doesn't exist.
    bucketName: process.env.MINIO_BUCKET_NAME || 'ehte-media',

    // Production: true (HTTPS required). Local: false (plain MinIO).
    useSSL: process.env.MINIO_USE_SSL === 'true',

    // ADDED: was missing entirely, so MinioService's own fallback
    // ('us-east-1') was always used regardless of what MINIO_REGION was
    // set to. Some S3-compatible providers require this to be set
    // explicitly (e.g. 'auto' for Cloudflare R2) rather than relying on
    // an alias, matching every official SDK example (boto3, aws-sdk,
    // etc.), which always pass region explicitly.
    region: process.env.MINIO_REGION || 'us-east-1',

    // FIX: previously read directly off process.env in MinioService,
    // bypassing ConfigService/Joi entirely — a non-numeric value would
    // silently become NaN instead of failing fast at boot. Centralized
    // here like every other config value; MinioService now reads
    // configService.get<number>('minio.presignDurationSeconds').
    // Default lowered from 120s to 600s (10 min) — long enough for a
    // real upload/download, short enough that a leaked presigned URL
    // (e.g. for victim or missing-person media) doesn't stay exploitable
    // for long.
    presignDurationSeconds: parseInt(process.env.DURATION_OF_PRE_SIGNED_DOCUMENT ?? '600', 10),
  },

  security: {
    encryptionKey: process.env.ENCRYPTION_KEY,

    encryptionIv: process.env.ENCRYPTION_IV,

    // Login lockout, enforced in AuthService.recordFailedLogin() /
    // assertNotLocked() — used by both login() and adminLogin().
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS ?? '5', 10),

    lockoutDurationMinutes: parseInt(process.env.LOCKOUT_DURATION_MINUTES ?? '15', 10),
  },

  // FIX: both fallbacks below were out of sync with the values actually
  // used elsewhere (app.module.ts's Joi defaults, and PostService's own
  // MEDIA_MAX_FILE_SIZE / MEDIA_ALLOWED_MIME_TYPES reads). They only
  // apply when the env vars are completely unset, but a stale fallback
  // here is still a real bug: it silently disagreed with the size cap
  // recommended in .env and left `application/pdf` off the allowed list,
  // meaning a post with pdf/document media would fail validation even
  // though CreatePostDto/UpdatePostDto both accept those fields.
  media: {
    maxFileSize: parseInt(process.env.MEDIA_MAX_FILE_SIZE ?? '52428800', 10),

    allowedMimeTypes:
      process.env.MEDIA_ALLOWED_MIME_TYPES ||
      'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp4,application/pdf',
  },

  // NOTE: content.* is deliberately NOT namespaced here the way media/minio
  // are. PostService reads CONTENT_MAX_PENDING_PER_USER,
  // CONTENT_CREATE_RATE_LIMIT_WINDOW_SECONDS, CONTENT_DRAFT_TTL_DAYS,
  // CONTENT_REJECTED_RETENTION_DAYS, CONTENT_STALE_PENDING_HOURS (and their
  // optional POST_* overrides) directly via configService.get('RAW_ENV_NAME'),
  // the same way it reads MEDIA_MAX_FILE_SIZE directly rather than through
  // media.maxFileSize. @nestjs/config's ConfigService falls through to
  // process.env for keys not present in the loaded config object, so this
  // works without an entry here — but if Reports/MissingPerson/Profile
  // services end up wanting a namespaced `content.*` lookup instead of the
  // raw env-var pattern, add it here rather than duplicating parseInt logic
  // across every module's service file.

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
});