import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import * as Joi from 'joi';

import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

import { ScheduleModule } from '@nestjs/schedule';

import configuration from './configuration/configuration';

import { PrismaModule } from './prisma/prisma.module';
import { MinioModule } from './infrastructure/minio/minio.module';
import { RedisModule } from './infrastructure/redis/redis.module';
import { RedisThrottlerStorage } from './infrastructure/redis/redis-throttler.storage';
import { AppLoggerModule } from './common/logger/logger.module';
import { RequestContextModule } from './common/request-context/request-context.module';
import { EmailModule } from './infrastructure/email/email.module';

import { UserModule } from './modules/core/user/user.module';
import { ReportModule } from './modules/core/report/report.module';
import { PostModule } from './modules/core/post/post.module';
import { MissingPersonModule } from './modules/core/missing-person/missing-person.module';
import { InformationSubmissionModule } from './modules/core/information-submission/information-submission.module';
import { VictimProfileModule } from './modules/core/victim-profile/victim-profile.module';
import { SupportModule } from './modules/core/support/support.module';

import { MediaModule } from './modules/media/media.module';

import { AuditLogModule } from './modules/misc/audit-log/audit-log.module';
import { NotificationModule } from './modules/misc/notification/notification.module';
import { ExplorerModule } from './modules/misc/explorer/explorer.module';

import { AppAccessModule } from './modules/app-access/app-access.module';

import { PayerBillingModule } from './modules/billing/payer-billing/payer-billing.module';
import { PaymentAdminModule } from './modules/billing/payment-admin/payment-admin.module';
import { InstitutionAdminModule } from './modules/billing/institution-admin/institution-admin.module';
import { DisbursementAdminModule } from './modules/billing/disbursement-admin/disbursement-admin.module';
import { RewardAdminModule } from './modules/billing/reward-admin/reward-admin.module';
import { PaymentModule } from './modules/billing/payment/payment.module';
import { ChapaWebhookModule } from './modules/billing/chapa-webhook/chapa-webhook.module';
import { AgreementModule } from './modules/billing/agreement/agreement.module';
import { DisbursementModule } from './modules/billing/disbursement/disbursement.module';
import { RewardModule } from './modules/billing/reward/reward.module';
import { BillingReportModule } from './modules/billing/billing-report/billing-report.module';

// FIX: was never wired into AppModule despite existing in the tree.
import { UssdModule } from './modules/ussd/ussd.module';

import { AuthModule } from './modules/auth/auth.module';

import { JwtStrategy } from './common/guards/jwt.strategy';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';

import { PermissionsGuard } from './common/guards/permissions.guard';

import { ReauthGuard } from './common/guards/reauth.guard';

import { ActorContextInterceptor } from './common/interceptors/actor-context.interceptor';

import { AdminSeeder } from './common/seed/admin.seeder';
import { UserSeeder } from './common/seed/user.seeder';
import { RolesSeeder } from './common/seed/roles.seeder';
import { PermissionsSeeder } from './common/seed/permissions.seeder';
import { SeedOrchestratorService } from './common/seed/seed-orchestrator.service';

/**
 * Metadata key prefix @nestjs/throttler uses for @Throttle({ <name>: {...} }).
 * The decorator stores its settings under THROTTLER_LIMIT + <throttler name>
 * on the handler or class. Kept local to avoid depending on a deep import.
 * (v5/v6 value is 'THROTTLER:LIMIT' — verify if you upgrade the package.)
 */
const THROTTLER_LIMIT_PREFIX = 'THROTTLER:LIMIT';

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

      load: [configuration],

      validationSchema: Joi.object({
        NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
        PORT: Joi.number().default(3000),
        APP_NAME: Joi.string().default('Ehte'),

        EMAIL_LOGO_URL: Joi.string()
          .uri({ scheme: ['https'] })
          .optional()
          .allow(''),

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

        // Blank values are allowed: the .env ships these empty until a provider is enabled.
        GOOGLE_CLIENT_ID: Joi.string().optional().allow(''),
        FACEBOOK_APP_ID: Joi.string().optional().allow(''),
        FACEBOOK_APP_SECRET: Joi.string().optional().allow(''),
        APPLE_CLIENT_ID: Joi.string().optional().allow(''),

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

        FIREBASE_PROJECT_ID: Joi.string().optional(),
        FIREBASE_CLIENT_EMAIL: Joi.string().email().optional(),
        FIREBASE_PRIVATE_KEY: Joi.string().optional(),

        MINIO_ENDPOINT: Joi.string().required(),
        MINIO_PORT: Joi.number().default(9000),
        // Optional: public https origin the browser uses to reach MinIO (presigned URLs).
        MINIO_PUBLIC_URL: Joi.string()
          .uri({ scheme: ['http', 'https'] })
          .optional(),
        MINIO_ACCESS_KEY: Joi.string().required(),
        MINIO_SECRET_KEY: Joi.string().required(),
        MINIO_BUCKET_NAME: Joi.string().required(),
        MINIO_USE_SSL: Joi.boolean().default(false),
        MINIO_REGION: Joi.string().default('us-east-1'),
        DURATION_OF_PRE_SIGNED_DOCUMENT: Joi.number().default(600),

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
        REDIS_SECURITY_URL: Joi.string()
          .uri(REDIS_URL_SCHEMES)
          .custom(requireSecureRedisUrl)
          .optional(),
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

        PAYMENTS_ENABLED: Joi.boolean().default(false),
        PAYMENTS_REWARDS_ENABLED: Joi.boolean().default(false),
        PAYMENTS_RETURN_URL: Joi.string()
          .uri()
          .when('PAYMENTS_ENABLED', {
            is: true,
            then: Joi.required(),
            otherwise: Joi.optional().allow(''),
          }),
        PAYMENTS_MIN_SUPPORT_ETB: Joi.number().default(10),

        // Days before an unanswered non-financial support offer is auto-cancelled.
        SUPPORT_OFFER_EXPIRY_DAYS: Joi.number().integer().min(1).default(14),

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

        // ── URLs / deep links / proxy ─────────────────────────────────────
        APP_URL: Joi.string().uri().optional(),
        ADMIN_APP_URL: Joi.string().uri().optional(),
        FRONTEND_URL: Joi.string().uri().optional(),
        WEB_BASE_URL: Joi.string().uri().optional(),
        APP_DEEP_LINK_SCHEME: Joi.string().default('ehte'),
        APP_DEEP_LINK_BASE: Joi.string().default('ehte://missing-persons'),
        ANDROID_STORE_URL: Joi.string().uri().optional(),
        IOS_STORE_URL: Joi.string().uri().optional(),
        TRUST_PROXY_HOPS: Joi.number().integer().min(0).default(0),
        GEOIP_CITY_DB_PATH: Joi.string().optional().allow(''),
        GEOIP_ASN_DB_PATH: Joi.string().optional().allow(''),
        GEO_TRUST_HEADERS: Joi.boolean().default(false),

        // ── Token / 2FA secrets and auth tuning ───────────────────────────
        JWT_REGISTRATION_SECRET: Joi.string().min(32).optional(),
        TWO_FACTOR_ENCRYPTION_KEY: Joi.string()
          .pattern(/^[0-9a-fA-F]{64}$/)
          .optional()
          .messages({
            'string.pattern.base':
              'TWO_FACTOR_ENCRYPTION_KEY must be 64 hex chars (openssl rand -hex 32)',
          }),
        TWO_FACTOR_ISSUER: Joi.string().default('Ehte'),
        TWO_FACTOR_SMS_ENABLED: Joi.boolean().default(false),
        PASSWORD_MIN_LENGTH: Joi.number().integer().min(6).default(8),
        MAX_REAUTH_ATTEMPTS: Joi.number().integer().min(1).default(5),
        SELF_REACTIVATION_ENABLED: Joi.boolean().default(false),

        // ── Seeders (blank allowed; seeders fall back to their own defaults when unset) ──
        ADMIN_EMAIL: Joi.string().email().optional().allow(''),
        ADMIN_NAME: Joi.string().optional().allow(''),
        ADMIN_PASSWORD: Joi.string().optional().allow(''),
        USER_NAME: Joi.string().optional().allow(''),
        USER_PHONE: Joi.string().optional().allow(''),
        USER_PASSWORD: Joi.string().optional().allow(''),

        // ── Audit / notification / report ─────────────────────────────────
        AUDIT_PURGE_TOKEN_SECRET: Joi.string().min(32).optional(),
        AUDIT_PURGE_MIN_NOTICE_HOURS: Joi.number().min(0).default(72),
        AUDIT_WORKER_ENABLED: Joi.boolean().default(true),
        NOTIFICATION_WORKER_ENABLED: Joi.boolean().default(true),
        NOTIFICATION_DEFAULT_TIMEZONE: Joi.string().default('Africa/Addis_Ababa'),
        NOTIFICATION_READ_RETENTION_DAYS: Joi.number().integer().min(1).default(180),
        NOTIFICATION_BROADCAST_APPROVAL_THRESHOLD: Joi.number().integer().min(1).default(1000),
        REPORT_ANON_MASK_SECRET: Joi.string().min(32).optional(),
        REPORT_STATS_TZ: Joi.string().default('Africa/Addis_Ababa'),
        SMS_MAX_LENGTH: Joi.number().integer().min(1).default(300),

        // ── Feature flags ────────────────────────────────────────────────
        SUPPORT_CURRENCY: Joi.string().default('ETB'),
        SUPPORT_ENABLED: Joi.boolean().default(true),
        MISSING_PERSONS_ENABLED: Joi.boolean().default(true),
        VICTIM_SUPPORT_ENABLED: Joi.boolean().default(true),

        // ── Per-module limits with no CONTENT_* fallback ──────────────────
        INFORMATION_SUBMISSION_MAX_OPEN_QUESTIONS: Joi.number().integer().min(1).default(3),
        INFORMATION_SUBMISSION_APPEAL_WINDOW_DAYS: Joi.number().integer().min(1).default(14),
        INFORMATION_SUBMISSION_EXPORT_MAX_ROWS: Joi.number().integer().min(1).default(5000),
        INFORMATION_SUBMISSION_EXPORT_TTL_HOURS: Joi.number().integer().min(1).default(24),
        REPORT_EXPORT_MAX_ROWS: Joi.number().integer().min(1).default(5000),
        REPORT_EXPORT_JOB_MAX_ROWS: Joi.number().integer().min(1).default(100000),
        REPORT_EXPORT_TTL_DAYS: Joi.number().integer().min(1).default(7),
        REPORT_MAP_MAX_POINTS: Joi.number().integer().min(1).default(5000),
        REPORT_MAX_DRAFTS_PER_USER: Joi.number().integer().min(1).default(20),
        PROFILE_EXPORT_MAX_ROWS: Joi.number().integer().min(1).default(5000),
        PROFILE_EXPORT_JOB_MAX_ROWS: Joi.number().integer().min(1).default(100000),
        PROFILE_EXPORT_TTL_HOURS: Joi.number().integer().min(1).default(24),
        PROFILE_MAX_APPEALS: Joi.number().integer().min(1).default(2),
        PROFILE_MAX_UPDATES_PER_DAY: Joi.number().integer().min(1).default(10),
        PROFILE_STALE_CHILD_HOURS: Joi.number().integer().min(1).default(12),
        MISSING_PERSON_EXPORT_MAX_ROWS: Joi.number().integer().min(1).default(5000),
        MISSING_PERSON_EXPORT_TTL_HOURS: Joi.number().integer().min(1).default(24),
        MISSING_PERSON_RENEW_DEFAULT_DAYS: Joi.number().integer().min(1).default(30),

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
            name: 'checkout',
            ttl: config.get<number>('PAYMENT_CHECKOUT_RATE_LIMIT_TTL_SECONDS', 60) * 1000,
            limit: config.get<number>('PAYMENT_CHECKOUT_RATE_LIMIT', 5),
            skipIf: (context) => {
              const key = `${THROTTLER_LIMIT_PREFIX}checkout`;
              const optedIn =
                Reflect.getMetadata(key, context.getHandler()) !== undefined ||
                Reflect.getMetadata(key, context.getClass()) !== undefined;
              return !optedIn;
            },
          },
        ],
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

    UserModule,
    ReportModule,
    PostModule,
    MissingPersonModule,
    InformationSubmissionModule,
    VictimProfileModule,
    SupportModule,

    PayerBillingModule,
    PaymentAdminModule,
    InstitutionAdminModule,
    DisbursementAdminModule,
    RewardAdminModule,
    PaymentModule,
    ChapaWebhookModule,
    AgreementModule,
    DisbursementModule,
    RewardModule,
    BillingReportModule,

    MediaModule,

    AuditLogModule,
    NotificationModule,
    ExplorerModule,

    AppAccessModule,

    UssdModule,
  ],

  controllers: [],

  providers: [
    JwtStrategy,

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