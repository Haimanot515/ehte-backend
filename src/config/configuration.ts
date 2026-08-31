export default () => ({
  app: {
    name: process.env.APP_NAME || 'Ehte',
    env: process.env.NODE_ENV || 'development',
    port: Number(process.env.PORT) || 3000,
  },

  database: {
    url: process.env.DATABASE_URL,
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
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
    ttl: parseInt(
      process.env.RATE_LIMIT_TTL ?? '60',
      10,
    ),
    limit: parseInt(
      process.env.RATE_LIMIT_LIMIT ?? '100',
      10,
    ),
  },

  otp: {
    expiresInMinutes: parseInt(
      process.env.OTP_EXPIRES_IN_MINUTES ?? '10',
      10,
    ),
  },

  minio: {
    endpoint:
      process.env.MINIO_ENDPOINT || 'localhost',

    port: Number(
      process.env.MINIO_PORT || 9000,
    ),

    accessKey:
      process.env.MINIO_ACCESS_KEY,

    secretKey:
      process.env.MINIO_SECRET_KEY,

    bucket:
      process.env.MINIO_BUCKET || 'ehte',

    useSSL:
      process.env.MINIO_USE_SSL === 'true',
  },

  security: {
    encryptionKey:
      process.env.ENCRYPTION_KEY,

    encryptionIv:
      process.env.ENCRYPTION_IV,
  },

  media: {
    maxFileSize: parseInt(
      process.env.MEDIA_MAX_FILE_SIZE ??
        '10485760',
      10,
    ),

    allowedMimeTypes:
      process.env.MEDIA_ALLOWED_MIME_TYPES ||
      'image/jpeg,image/png,image/webp,video/mp4,audio/mpeg,audio/wav',
  },

  support: {
    currency:
      process.env.SUPPORT_CURRENCY || 'ETB',

    enabled:
      process.env.SUPPORT_ENABLED !== 'false',
  },

  missingPersons: {
    enabled:
      process.env.MISSING_PERSONS_ENABLED !==
      'false',
  },

  victimSupport: {
    enabled:
      process.env.VICTIM_SUPPORT_ENABLED !==
      'false',
  },
});