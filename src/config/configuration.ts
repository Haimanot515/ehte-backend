export default () => ({
  app: {
    name: process.env.APP_NAME || 'Ehte',
    env: process.env.NODE_ENV || 'development',
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
  firebase: {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY,
  },

  database: {
    url: process.env.DATABASE_URL,
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',

    // Without this mapping, refresh lookups silently fell back to jwt.secret.
    refreshSecret: process.env.JWT_REFRESH_SECRET,

    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
  },

  cors: {
    origin: process.env.CORS_ORIGIN || '*',
    credentials: process.env.CORS_CREDENTIALS === 'true',
  },

  // Swagger is off by default; enable with SWAGGER_ENABLED=true.
  swagger: {
    enabled: process.env.SWAGGER_ENABLED === 'true',
  },

  rateLimit: {
    ttl: parseInt(process.env.RATE_LIMIT_TTL ?? '60', 10),
    limit: parseInt(process.env.RATE_LIMIT_LIMIT ?? '100', 10),
  },

  otp: {
    expiresInMinutes: parseInt(process.env.OTP_EXPIRES_IN_MINUTES ?? '10', 10),

    // Minimum gap between OTP resends, enforced in AuthService.issueAndSendOtp().
    resendCooldownSeconds: parseInt(process.env.OTP_RESEND_COOLDOWN_SECONDS ?? '60', 10),
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
  },

  security: {
    encryptionKey: process.env.ENCRYPTION_KEY,

    encryptionIv: process.env.ENCRYPTION_IV,

    // Login lockout, enforced in AuthService for login() and adminLogin().
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS ?? '5', 10),

    lockoutDurationMinutes: parseInt(process.env.LOCKOUT_DURATION_MINUTES ?? '15', 10),
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
});