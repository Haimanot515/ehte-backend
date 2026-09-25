import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import * as Joi from 'joi';

import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

import { ScheduleModule } from '@nestjs/schedule';

import configuration from './config/configuration';
import minioConfig from './config/minio.config';
import emailConfig from './config/email.config';

import { PrismaModule } from './prisma/prisma.module';
import { MinioModule } from './services/minio/minio.module';
import { RedisModule } from './services/redis/redis.module';
import { RedisThrottlerStorage } from './services/redis/redis-throttler.storage';
import { AppLoggerModule } from './common/logger/logger.module';
import { RequestContextModule } from './common/request-context/request-context.module';
import { EmailModule } from './services/email/email.module';

import { CoreModule } from './modules/core/core.module';

import { MediaModule } from './modules/media/media.module';

import { MiscModule } from './modules/misc/misc.module';

import { AppAccessModule } from './modules/app-access/app-access.module';

import { BillingModule } from './modules/billing/billing.module';

// FIX: was never wired into AppModule despite existing in the tree.
import { UssdModule } from './modules/ussd/ussd.module';

import { AuthModule } from './modules/auth/auth.module';

import { JwtStrategy } from './common/guards/jwt.strategy';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';

import { PermissionsGuard } from './common/guards/permissions.guard';

import { ReauthGuard } from './common/guards/reauth.guard';
import { ReauthService } from './services/reauthentication/reauth.service';

import { ActorContextInterceptor } from './common/interceptors/actor-context.interceptor';

import { AdminSeeder } from './common/seed/admin.seeder';
import { UserSeeder } from './common/seed/user.seeder';
import { RolesSeeder } from './common/seed/roles.seeder';
import { PermissionsSeeder } from './common/seed/permissions.seeder';
import { SeedOrchestratorService } from './common/seed/seed-orchestrator.service';

/**
 * Production Redis URL rules (applied to REDIS_URL and REDIS_SECURITY_URL):
 *  - must carry a password (redis://:password@host:port), and
 *  - must use TLS (rediss://), unless REDIS_ALLOW_INSECURE=true.
 * The cache holds victim, child and tip data, and the security instance holds
 * lockout and throttle state, so neither should run unauthenticated or in
 * clear text. Outside production this is a no-op.
 */
const requireSecureRedisUrl = (value: string, helpers: Joi.CustomHelpers) => {
  const root = (helpers.state.ancestors?.[0] ?? {}) as Record<string, unknown>;
  if (root.NODE_ENV !== 'production') return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value; // .uri() already reports a malformed URL
  }

  const insecureAllowed = String(root.REDIS_ALLOW_INSECURE) === 'true';
  if (!insecureAllowed && url.protocol !== 'rediss:') {
    return helpers.message({
      custom: '{{#label}} must use rediss:// (TLS) in production, or set REDIS_ALLOW_INSECURE=true',
    });
  }
  if (!url.password) {
    return helpers.message({
      custom: '{{#label}} must include a password (redis://:password@host:port) in production',
    });
  }
  return value;
};

const REDIS_URL_SCHEMES = { scheme: ['redis', 'rediss'] };

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,

      envFilePath: [`.env.${process.env.NODE_ENV}`, '.env'],

      load: [configuration, minioConfig, emailConfig],

      validationSchema: Joi.object({
        NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
        PORT: Joi.number().default(3000),
        APP_NAME: Joi.string().default('Ehte'),

        CORS_ORIGIN: Joi.string().required(),
        CORS_CREDENTIALS: Joi.boolean().default(true),

        SWAGGER_ENABLED: Joi.boolean().default(true),
        SWAGGER_USER: Joi.string().optional(),
        SWAGGER_PASSWORD: Joi.string().optional(),

        DATABASE_URL: Joi.string().required(),
        RUN_MIGRATIONS: Joi.boolean().default(true),

        JWT_SECRET: Joi.string().min(32).required(),
        JWT_EXPIRES_IN: Joi.string().default('15m'),
        JWT_REFRESH_SECRET: Joi.string().min(32).optional(),
        JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

        // Social login (SocialAuthUtil, src/common/utils/social-auth.util.ts).
        // Optional at the schema level — the app boots fine with social login
        // entirely unconfigured — but SocialAuthUtil reads all three via
        // getOrThrow(), so setting only HALF of a pair (e.g. FACEBOOK_APP_ID
        // without FACEBOOK_APP_SECRET) used to fail silently at boot and only
        // surface on the first real request. The .and(...) below at least
        // catches that one Facebook case at boot; Google/Apple are single
        // values so there's no pair to enforce.
        GOOGLE_CLIENT_ID: Joi.string().optional(),
        FACEBOOK_APP_ID: Joi.string().optional(),
        FACEBOOK_APP_SECRET: Joi.string().optional(),
        APPLE_CLIENT_ID: Joi.string().optional(),

        OTP_EXPIRES_IN_MINUTES: Joi.number().default(10),
        OTP_RESEND_COOLDOWN_SECONDS: Joi.number().default(60),
        OTP_MAX_ATTEMPTS: Joi.number().default(5),

        MAX_LOGIN_ATTEMPTS: Joi.number().default(5),
        LOCKOUT_DURATION_MINUTES: Joi.number().default(15),

        // Password hashing cost (signup, resetPassword, changePasswordVerify
        // in AuthService). OTP hashing uses its own, separate cost below.
        BCRYPT_SALT_ROUNDS: Joi.number().integer().min(4).max(15).default(10),

        // OTP hashing cost, used only in AuthService.signup().
        BCRYPT_OTP_SALT_ROUNDS: Joi.number().integer().min(4).max(15).default(12),

        APP_DEBUG: Joi.boolean()
          .default(false)
          .when('NODE_ENV', {
            is: 'production',
            then: Joi.valid(false),
            otherwise: Joi.optional(),
          }),

        THROTTLE_TTL_SECONDS: Joi.number().default(60),
        THROTTLE_LIMIT: Joi.number().default(20),

        SENDET_URL: Joi.string().uri().optional(),
        SENDET_TOKEN: Joi.string().optional(),
        SENDET_SENDER_NAME: Joi.string().optional(),
        SENDET_TIMEOUT_MS: Joi.number().default(10000),

        // Optional: PUSH delivery is disabled when unset, everything else still boots.
        // All three optional individually, but if you set ANY one of them you must
        // set all three — a partial config used to fail silently (push just stayed
        // off with no error), which made misconfiguration hard to notice. Enforced
        // below via .and(...) on the schema.
        FIREBASE_PROJECT_ID: Joi.string().optional(),
        FIREBASE_CLIENT_EMAIL: Joi.string().email().optional(),
        FIREBASE_PRIVATE_KEY: Joi.string().optional(),

        MINIO_ENDPOINT: Joi.string().required(),
        MINIO_PORT: Joi.number().default(9000),
        MINIO_ACCESS_KEY: Joi.string().required(),
        MINIO_SECRET_KEY: Joi.string().required(),
        MINIO_BUCKET_NAME: Joi.string().required(),
        MINIO_USE_SSL: Joi.boolean().default(false),
        MINIO_REGION: Joi.string().default('us-east-1'),
        DURATION_OF_PRE_SIGNED_DOCUMENT: Joi.number().default(600),

        // Redis. In production the server refuses to start unless Redis is
        // reached over TLS (rediss://) with a password. REDIS_URL wins over
        // host/port; host/port mode has no TLS support, so in production it is
        // only accepted with REDIS_ALLOW_INSECURE=true.
        REDIS_ALLOW_INSECURE: Joi.boolean().default(false),
        REDIS_URL: Joi.string()
          .uri(REDIS_URL_SCHEMES)
          .custom(requireSecureRedisUrl)
          .when('NODE_ENV', {
            is: 'production',
            then: Joi.string().when('REDIS_ALLOW_INSECURE', {
              is: true,
              then: Joi.optional(),
              otherwise: Joi.required(),
            }),
            otherwise: Joi.optional(),
          }),
        REDIS_HOST: Joi.string().default('localhost'),
        REDIS_PORT: Joi.number().default(6379),
        // Required in production when REDIS_URL (which can carry the password)
        // is not set.
        REDIS_PASSWORD: Joi.string().when('NODE_ENV', {
          is: 'production',
          then: Joi.string().when('REDIS_URL', {
            is: Joi.exist(),
            then: Joi.optional(),
            otherwise: Joi.required(),
          }),
          otherwise: Joi.optional(),
        }),
        REDIS_DB: Joi.number().default(0),
        // Separate instance for throttle / lockout / reset state so cache
        // eviction can't drop it. Unset = same Redis as the cache.
        REDIS_SECURITY_URL: Joi.string().uri(REDIS_URL_SCHEMES).custom(requireSecureRedisUrl).optional(),
        // Isolates environments that share one Redis. Empty string is allowed
        // (no prefix). Defaults are set in configuration.ts.
        REDIS_KEY_PREFIX: Joi.string()
          .pattern(/^[A-Za-z0-9:_-]*$/)
          .allow('')
          .optional(),

        MEDIA_MAX_FILE_SIZE: Joi.number().default(52_428_800),
        MEDIA_ALLOWED_MIME_TYPES: Joi.string().default(
          'image/jpeg,image/png,image/webp,video/mp4,video/quicktime,audio/mpeg,audio/wav,audio/mp4,application/pdf',
        ),

        // Payments (Chapa). Secrets and the return URL are only required
        // once PAYMENTS_ENABLED=true, so payments can stay off elsewhere
        // without needing dummy values.
        PAYMENTS_ENABLED: Joi.boolean().default(false),
        PAYMENTS_REWARDS_ENABLED: Joi.boolean().default(false),
        PAYMENTS_RETURN_URL: Joi.string().uri().when('PAYMENTS_ENABLED', {
          is: true,
          then: Joi.required(),
          otherwise: Joi.optional().allow(''),
        }),
        PAYMENTS_MIN_SUPPORT_ETB: Joi.number().default(10),

        CHAPA_SECRET_KEY: Joi.string().when('PAYMENTS_ENABLED', {
          is: true,
          then: Joi.required(),
          otherwise: Joi.optional(),
        }),
        CHAPA_WEBHOOK_SECRET: Joi.string().when('PAYMENTS_ENABLED', {
          is: true,
          then: Joi.required(),
          otherwise: Joi.optional(),
        }),
        CHAPA_BASE_URL: Joi.string().uri().default('https://api.chapa.co/v1'),
        CHAPA_FALLBACK_EMAIL: Joi.string().email().optional(),
        CHAPA_TIMEOUT_MS: Joi.number().default(15000),
        CHAPA_TITLE_MAX_LENGTH: Joi.number().default(16),
        CHAPA_DESCRIPTION_MAX_LENGTH: Joi.number().default(50),

        // Payment lifecycle timing (PaymentService: duplicate-submission window,
        // staleness/expiry sweep, and the repair-unconfirmed-supports age band).
        PAYMENT_DUPLICATE_WINDOW_MINUTES: Joi.number().default(30),
        PAYMENT_STALE_AFTER_MINUTES: Joi.number().default(15),
        PAYMENT_EXPIRY_HOURS: Joi.number().default(24),
        PAYMENT_REPAIR_MIN_AGE_MINUTES: Joi.number().default(2),
        PAYMENT_REPAIR_MAX_AGE_DAYS: Joi.number().default(7),

        // Drives both reconcileStale() and repairUnconfirmedSupports() cron
        // cadences (currently still static @Cron decorators — see PaymentService
        // notes; this key makes the interval *readable* pending a
        // SchedulerRegistry.addCronJob() refactor for true dynamic scheduling).
        PAYMENT_RECONCILE_INTERVAL_MINUTES: Joi.number().default(10),

        // Named 'checkout' throttler profile (PaymentController: support checkout
        // + reward funding), separate from the global THROTTLE_* default.
        PAYMENT_CHECKOUT_RATE_LIMIT: Joi.number().default(5),
        PAYMENT_CHECKOUT_RATE_LIMIT_TTL_SECONDS: Joi.number().default(60),

        DISBURSEMENT_PROCESSING_TIMEOUT_MINUTES: Joi.number().default(60),

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

        POST_MAX_PENDING_PER_USER: Joi.number().optional(),
        POST_CREATE_RATE_LIMIT_WINDOW_SECONDS: Joi.number().optional(),
        POST_DRAFT_TTL_DAYS: Joi.number().optional(),
        POST_REJECTED_RETENTION_DAYS: Joi.number().optional(),
        POST_STALE_PENDING_HOURS: Joi.number().optional(),
        POST_MAX_PHOTOS: Joi.number().optional(),
        POST_MAX_VIDEOS: Joi.number().optional(),
        POST_MAX_OTHER_FILES: Joi.number().optional(),
        POST_MAX_TOTAL_UPLOAD_BYTES: Joi.number().optional(),
        POST_AUTO_FLAG_REJECTION_COUNT: Joi.number().optional(),
        POST_AUTO_FLAG_WINDOW_DAYS: Joi.number().optional(),

        REPORT_MAX_PENDING_PER_USER: Joi.number().optional(),
        REPORT_CREATE_RATE_LIMIT_WINDOW_SECONDS: Joi.number().optional(),
        REPORT_DRAFT_TTL_DAYS: Joi.number().optional(),
        REPORT_REJECTED_RETENTION_DAYS: Joi.number().optional(),
        REPORT_STALE_PENDING_HOURS: Joi.number().optional(),
        REPORT_MAX_PHOTOS: Joi.number().optional(),
        REPORT_MAX_VIDEOS: Joi.number().optional(),
        REPORT_MAX_OTHER_FILES: Joi.number().optional(),
        REPORT_MAX_TOTAL_UPLOAD_BYTES: Joi.number().optional(),
        REPORT_AUTO_FLAG_REJECTION_COUNT: Joi.number().optional(),
        REPORT_AUTO_FLAG_WINDOW_DAYS: Joi.number().optional(),

        MISSING_PERSON_MAX_PENDING_PER_USER: Joi.number().optional(),
        MISSING_PERSON_CREATE_RATE_LIMIT_WINDOW_SECONDS: Joi.number().optional(),
        MISSING_PERSON_REJECTED_RETENTION_DAYS: Joi.number().optional(),
        MISSING_PERSON_STALE_PENDING_HOURS: Joi.number().optional(),
        MISSING_PERSON_MAX_PHOTOS: Joi.number().optional(),
        MISSING_PERSON_MAX_VIDEOS: Joi.number().optional(),
        MISSING_PERSON_MAX_OTHER_FILES: Joi.number().optional(),
        MISSING_PERSON_MAX_TOTAL_UPLOAD_BYTES: Joi.number().optional(),
        MISSING_PERSON_AUTO_FLAG_REJECTION_COUNT: Joi.number().optional(),
        MISSING_PERSON_AUTO_FLAG_WINDOW_DAYS: Joi.number().optional(),

        PROFILE_MAX_PENDING_PER_USER: Joi.number().optional(),
        PROFILE_CREATE_RATE_LIMIT_WINDOW_SECONDS: Joi.number().optional(),
        PROFILE_REJECTED_RETENTION_DAYS: Joi.number().optional(),
        PROFILE_STALE_PENDING_HOURS: Joi.number().optional(),
        PROFILE_MAX_PHOTOS: Joi.number().optional(),
        PROFILE_MAX_VIDEOS: Joi.number().optional(),
        PROFILE_MAX_OTHER_FILES: Joi.number().optional(),
        PROFILE_MAX_TOTAL_UPLOAD_BYTES: Joi.number().optional(),
        PROFILE_AUTO_FLAG_REJECTION_COUNT: Joi.number().optional(),
        PROFILE_AUTO_FLAG_WINDOW_DAYS: Joi.number().optional(),

        SMTP_HOST: Joi.string().required(),
        SMTP_PORT: Joi.number().default(587),
        SMTP_SECURE: Joi.boolean().default(false),
        SMTP_USER: Joi.string().required(),
        SMTP_PASSWORD: Joi.string().required(),
        SMTP_FROM: Joi.string().optional(),
        SMTP_FROM_NAME: Joi.string().default('Ehte'),
      })
        .and('FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY')
        .and('FACEBOOK_APP_ID', 'FACEBOOK_APP_SECRET'),

      validationOptions: {
        abortEarly: false,
        allowUnknown: true,
      },
    }),

    EventEmitterModule.forRoot(),

    ScheduleModule.forRoot(),

    ThrottlerModule.forRootAsync({
      // RedisModule is @Global, but importing it here makes the dependency on
      // RedisThrottlerStorage explicit.
      imports: [ConfigModule, RedisModule],
      inject: [ConfigService, RedisThrottlerStorage],
      useFactory: (config: ConfigService, storage: RedisThrottlerStorage) => ({
        throttlers: [
          {
            ttl: config.get<number>('THROTTLE_TTL_SECONDS', 60) * 1000,
            limit: config.get<number>('THROTTLE_LIMIT', 20),
          },
          {
            // Named profile for payment-initiating routes (checkout, reward
            // funding). Activated on a route via @Throttle({ checkout: {} }).
            //
            // VERIFY: in current @nestjs/throttler versions every named
            // throttler runs on every route unless skipped, so this 5/60s
            // limit may be applying app-wide. Check for
            // @SkipThrottle({ checkout: true }) on non-payment controllers.
            name: 'checkout',
            ttl: config.get<number>('PAYMENT_CHECKOUT_RATE_LIMIT_TTL_SECONDS', 60) * 1000,
            limit: config.get<number>('PAYMENT_CHECKOUT_RATE_LIMIT', 5),
          },
        ],
        // Shared counters across instances (was unset, so ThrottlerGuard used
        // per-instance in-memory storage). Falls back to in-memory only while
        // Redis is unreachable.
        storage,
      }),
    }),

    PassportModule,

    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.secret'),
      }),
    }),

    PrismaModule,

    AppLoggerModule,

    RequestContextModule,

    MinioModule,

    RedisModule,

    EmailModule,

    AuthModule,

    CoreModule,

    BillingModule,

    MediaModule,

    MiscModule,

    AppAccessModule,

    UssdModule,
  ],

  controllers: [],

  providers: [
    JwtStrategy,

    ReauthService,

    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: ReauthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },

    { provide: APP_INTERCEPTOR, useClass: ActorContextInterceptor },

    RolesSeeder,
    PermissionsSeeder,
    AdminSeeder,
    UserSeeder,
    SeedOrchestratorService,
  ],
})
export class AppModule {}