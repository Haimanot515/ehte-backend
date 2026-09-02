export default () => ({
  app: {
    name: process.env.APP_NAME || 'Ehte',
    env: process.env.NODE_ENV || 'development',
    port: Number(process.env.PORT) || 3000,

    // Gates dev-only OTP console logging in AuthService. MUST be false
    // in production — leaving it true prints real OTPs to server logs.
    debug: process.env.APP_DEBUG === 'true',
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
    endpoint: process.env.MINIO_ENDPOINT || 'localhost',

    port: Number(process.env.MINIO_PORT || 9000),

    accessKey: process.env.MINIO_ACCESS_KEY,

    secretKey: process.env.MINIO_SECRET_KEY,

    bucket: process.env.MINIO_BUCKET || 'ehte',

    useSSL: process.env.MINIO_USE_SSL === 'true',
  },

  security: {
    encryptionKey: process.env.ENCRYPTION_KEY,

    encryptionIv: process.env.ENCRYPTION_IV,

    // Login lockout, enforced in AuthService.recordFailedLogin() /
    // assertNotLocked() — used by both login() and adminLogin().
    maxLoginAttempts: parseInt(process.env.MAX_LOGIN_ATTEMPTS ?? '5', 10),

    lockoutDurationMinutes: parseInt(process.env.LOCKOUT_DURATION_MINUTES ?? '15', 10),
  },

  media: {
    maxFileSize: parseInt(process.env.MEDIA_MAX_FILE_SIZE ?? '10485760', 10),

    allowedMimeTypes:
      process.env.MEDIA_ALLOWED_MIME_TYPES ||
      'image/jpeg,image/png,image/webp,video/mp4,audio/mpeg,audio/wav',
  },

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
