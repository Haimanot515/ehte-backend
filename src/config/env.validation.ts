// src/config/env.validation.ts
// Single source of truth for env defaults; configuration.ts fallbacks must match.

import * as Joi from 'joi';

// Required when NODE_ENV=production, optional otherwise.
const prodRequired = <T extends Joi.Schema>(schema: T): T =>
  schema.when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }) as T;

// Per-domain upload/moderation knobs: <PREFIX>_<KEY>, all optional overrides.
const overrides = (prefix: string, keys: string[]) =>
  Object.fromEntries(keys.map((k) => [`${prefix}_${k}`, Joi.number().integer().min(0).optional()]));

const COMMON_KEYS = [
  'MAX_PENDING_PER_USER',
  'CREATE_RATE_LIMIT_WINDOW_SECONDS',
  'REJECTED_RETENTION_DAYS',
  'STALE_PENDING_HOURS',
  'MAX_PHOTOS',
  'MAX_VIDEOS',
  'MAX_OTHER_FILES',
  'MAX_TOTAL_UPLOAD_BYTES',
  'AUTO_FLAG_REJECTION_COUNT',
  'AUTO_FLAG_WINDOW_DAYS',
];

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().default(3000),
  APP_NAME: Joi.string().default('Ehte'),

  // Must not point at localhost in production.
  APP_URL: prodRequired(Joi.string().uri()),
  ADMIN_APP_URL: Joi.string().uri().optional(),

  // Reverse-proxy hops; apply via app.set('trust proxy', ...) in main.ts.
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).default(0),

  // '*' is rejected by browsers when credentials are enabled.
  CORS_ORIGIN: Joi.string()
    .required()
    .when('CORS_CREDENTIALS', {
      is: Joi.boolean().valid(true).required(),
      then: Joi.string().invalid('*'),
    }),
  CORS_CREDENTIALS: Joi.boolean().default(false),

  SWAGGER_ENABLED: Joi.boolean().default(false),
  SWAGGER_USER: Joi.string().when('SWAGGER_ENABLED', {
    is: Joi.boolean().valid(true).required(),
    then: prodRequired(Joi.string()),
    otherwise: Joi.optional(),
  }),
  SWAGGER_PASSWORD: Joi.string().when('SWAGGER_ENABLED', {
    is: Joi.boolean().valid(true).required(),
    then: prodRequired(Joi.string()),
    otherwise: Joi.optional(),
  }),

  DATABASE_URL: Joi.string().required(),
  RUN_MIGRATIONS: Joi.boolean().default(true),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('15m'),
  // Required in production and must differ from JWT_SECRET.
  JWT_REFRESH_SECRET: prodRequired(Joi.string().min(32).invalid(Joi.ref('JWT_SECRET'))),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

  OTP_EXPIRES_IN_MINUTES: Joi.number().default(10),
  OTP_RESEND_COOLDOWN_SECONDS: Joi.number().default(60),

  MAX_LOGIN_ATTEMPTS: Joi.number().default(5),
  LOCKOUT_DURATION_MINUTES: Joi.number().default(15),

  // Deprecated static-IV scheme; kept only to read old data.

  APP_DEBUG: Joi.boolean()
    .default(false)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.valid(false),
      otherwise: Joi.optional(),
    }),

  THROTTLE_TTL_SECONDS: Joi.number().integer().min(1).default(60),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(20),

  // Production needs one working SMS provider: AfroMessage unless SendET is fully set.
  AFROMESSAGE_URL: Joi.string()
    .uri()
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().uri().when('SENDET_URL', {
        is: Joi.exist(),
        then: Joi.optional(),
        otherwise: Joi.required(),
      }),
      otherwise: Joi.optional(),
    }),
  AFROMESSAGE_TOKEN: Joi.string().when('NODE_ENV', {
    is: 'production',
    then: Joi.string().when('SENDET_TOKEN', {
      is: Joi.exist(),
      then: Joi.optional(),
      otherwise: Joi.required(),
    }),
    otherwise: Joi.optional(),
  }),
  AFROMESSAGE_SENDER_NAME: Joi.string().optional(),
  AFROMESSAGE_IDENTIFIER_ID: Joi.string().optional(),

  SENDET_URL: Joi.string().uri().optional(),
  SENDET_TOKEN: Joi.string().optional(),
  SENDET_SENDER_NAME: Joi.string().optional(),
  SENDET_TIMEOUT_MS: Joi.number().default(10000),

  MINIO_ENDPOINT: Joi.string().required(),
  MINIO_PORT: Joi.number().default(9000),
  MINIO_ACCESS_KEY: Joi.string().required(),
  MINIO_SECRET_KEY: Joi.string().required(),
  MINIO_BUCKET_NAME: Joi.string().required(),
  MINIO_USE_SSL: Joi.boolean().default(false),
  MINIO_REGION: Joi.string().default('us-east-1'),
  DURATION_OF_PRE_SIGNED_DOCUMENT: Joi.number().default(600),

  REDIS_URL: Joi.string().optional(),
  REDIS_HOST: Joi.string().default('localhost'),
  REDIS_PORT: Joi.number().default(6379),
  REDIS_PASSWORD: Joi.string().optional(),
  REDIS_DB: Joi.number().default(0),

  MEDIA_MAX_FILE_SIZE: Joi.number().default(52_428_800),
  MEDIA_ALLOWED_MIME_TYPES: Joi.string().default(
    'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp4,application/pdf',
  ),

  CONTENT_MAX_PENDING_PER_USER: Joi.number().default(5),
  CONTENT_CREATE_RATE_LIMIT_WINDOW_SECONDS: Joi.number().default(60),
  CONTENT_DRAFT_TTL_DAYS: Joi.number().default(30),
  CONTENT_REJECTED_RETENTION_DAYS: Joi.number().default(90),
  CONTENT_STALE_PENDING_HOURS: Joi.number().default(48),
  CONTENT_MAX_PHOTOS: Joi.number().default(5),
  CONTENT_MAX_VIDEOS: Joi.number().default(1),
  CONTENT_MAX_OTHER_FILES: Joi.number().default(2),
  CONTENT_MAX_TOTAL_UPLOAD_BYTES: Joi.number().default(52_428_800),
  CONTENT_AUTO_FLAG_REJECTION_COUNT: Joi.number().default(3),
  CONTENT_AUTO_FLAG_WINDOW_DAYS: Joi.number().default(7),

  ...overrides('POST', [...COMMON_KEYS, 'DRAFT_TTL_DAYS']),
  ...overrides('REPORT', [...COMMON_KEYS, 'DRAFT_TTL_DAYS']),
  ...overrides('MISSING_PERSON', COMMON_KEYS),
  ...overrides('PROFILE', COMMON_KEYS),

  SUPPORT_CURRENCY: Joi.string().default('ETB'),
  SUPPORT_ENABLED: Joi.boolean().default(true),
  MISSING_PERSONS_ENABLED: Joi.boolean().default(true),
  VICTIM_SUPPORT_ENABLED: Joi.boolean().default(true),

  SMTP_HOST: Joi.string().required(),
  SMTP_PORT: Joi.number().default(587),
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: Joi.string().required(),
  SMTP_PASSWORD: Joi.string().required(),
  SMTP_FROM: Joi.string().optional(),
  SMTP_FROM_NAME: Joi.string().default('Ehte'),

  // All three optional together; .and() below enforces all-or-nothing.
  FIREBASE_PROJECT_ID: Joi.string().optional(),
  FIREBASE_CLIENT_EMAIL: Joi.string().email().optional(),
  FIREBASE_PRIVATE_KEY: Joi.string().optional(),

  ANDROID_STORE_URL: prodRequired(Joi.string().uri()),
  IOS_STORE_URL: prodRequired(Joi.string().uri()),
}).and('FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY');
