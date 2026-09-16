import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import * as Joi from 'joi';

import { APP_GUARD } from '@nestjs/core';

import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { EventEmitterModule } from '@nestjs/event-emitter';

// ─────────────────────────────────────────────
// RATE LIMITING
//
// npm i @nestjs/throttler
// ─────────────────────────────────────────────

import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';

// ─────────────────────────────────────────────
// SCHEDULING
//
// npm i @nestjs/schedule
// Required for PostRetentionService's @Cron(...) (and any future
// scheduled job) to actually run. Registered once, globally, here —
// do NOT also call ScheduleModule.forRoot() inside PostModule or
// anywhere else, one registration for the whole app is enough.
// ─────────────────────────────────────────────

import { ScheduleModule } from '@nestjs/schedule';

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────

import configuration from './config/configuration';
import minioConfig from './config/minio.config';
import emailConfig from './config/email.config';

// ─────────────────────────────────────────────
// CORE / INFRASTRUCTURE MODULES
// ─────────────────────────────────────────────

import { PrismaModule } from './prisma/prisma.module';
import { MinioModule } from './services/minio/minio.module';
import { AppLoggerModule } from './common/logger/logger.module';
import { EmailModule } from './services/email/email.module';

// ─────────────────────────────────────────────
// APPLICATION CORE MODULE
//
// User
// Report
// Post
// Missing Person
// Information Submission
// Victim Profile
// Support
// ─────────────────────────────────────────────

import { CoreModule } from './modules/core/core.module';

// ─────────────────────────────────────────────
// MEDIA MODULE
//
// Generic presigned-upload + delete-by-key endpoints
// (POST /media/presigned-upload, DELETE /media?key=...).
// Deliberately domain-agnostic and standalone — no other
// module imports it, since MinioService is @Global() and
// already resolvable app-wide without going through here.
// Download/read authorization intentionally does NOT live
// in this module; see VictimProfileService /
// InformationSubmissionService's own getMediaDownloadUrl /
// getPublicMediaDownloadUrl methods for that.
// ─────────────────────────────────────────────

import { MediaModule } from './modules/media/media.module';

// ─────────────────────────────────────────────
// MISC / SYSTEM MODULE
//
// Audit Logs
// Notifications
// Audit Event Listeners
// Notification Event Listeners
// ─────────────────────────────────────────────

import { MiscModule } from './modules/misc/misc.module';

// ─────────────────────────────────────────────
// AUTHENTICATION
// ─────────────────────────────────────────────

import { AuthModule } from './modules/auth/auth.module';

import { JwtStrategy } from './common/guards/jwt.strategy';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';

// PermissionsGuard: fine-grained authorization layer that runs after
// RolesGuard. Role gets a caller in the door for a resource; permission
// decides what they can actually do to it. See
// common/decorators/require-permissions.decorator.ts for @RequirePermissions().
import { PermissionsGuard } from './common/guards/permissions.guard';

import { ReauthGuard } from './common/guards/reauth.guard';
import { ReauthService } from './services/reauthentication/reauth.service';

// ─────────────────────────────────────────────
// SEEDERS
// ─────────────────────────────────────────────

import { AdminSeeder } from './common/seed/admin.seeder';
import { RolesSeeder } from './common/seed/roles.seeder';
import { PermissionsSeeder } from './common/seed/permissions.seeder';

// ─────────────────────────────────────────────
// APP MODULE
// ─────────────────────────────────────────────

@Module({
  imports: [
    // ─────────────────────────────────────────
    // CONFIGURATION
    // ─────────────────────────────────────────

    ConfigModule.forRoot({
      isGlobal: true,

      envFilePath: [`.env.${process.env.NODE_ENV}`, '.env'],

      load: [configuration, minioConfig, emailConfig],

      validationSchema: Joi.object({
        NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),

        PORT: Joi.number().default(3000),

        APP_NAME: Joi.string().default('Ehte'),

        // CORS_ORIGIN may be a single origin or a
        // comma-separated list ("https://a.com,https://b.com").
        // main.ts splits this into an array before
        // passing it to enableCors(), and now also rejects
        // "*" whenever CORS_CREDENTIALS is true (see main.ts).
        CORS_ORIGIN: Joi.string().required(),

        CORS_CREDENTIALS: Joi.boolean().default(true),

        SWAGGER_ENABLED: Joi.boolean().default(true),

        // Optional basic-auth credentials protecting
        // the /docs route. FIX (weakness review #swagger-unprotected):
        // main.ts now throws at boot if SWAGGER_ENABLED is true and
        // either of these is missing in any environment other than
        // "development" — so in practice both are effectively required
        // whenever Swagger is turned on outside local dev.
        SWAGGER_USER: Joi.string().optional(),

        SWAGGER_PASSWORD: Joi.string().optional(),

        DATABASE_URL: Joi.string().required(),

        // Set to "false" to skip running
        // `prisma migrate deploy` on boot — use this
        // on every replica except the one designated
        // to run migrations (or run migrations via a
        // separate one-off job/init container instead).
        RUN_MIGRATIONS: Joi.boolean().default(true),

        // ─────────────────────────────────────
        // JWT
        // ─────────────────────────────────────

        // FIX (weakness review #weak-jwt-secret): 10 characters is roughly
        // 80 bits at best, and far less if it isn't truly random (e.g. a
        // short passphrase). For an HMAC-signed JWT, OWASP/NIST-aligned
        // guidance is a 256-bit (32+ byte) secret. Generate one with, e.g.,
        // `openssl rand -base64 48`. This raises the floor Joi will accept —
        // rotate any existing shorter secret in every environment before
        // deploying this change, since old tokens signed with it will
        // become unverifiable once the secret changes anyway.
        JWT_SECRET: Joi.string().min(32).required(),

        // FIX (weakness review #long-lived-access-token): access tokens
        // can't be revoked mid-life (no blocklist), and roles are baked in
        // at issuance — so a long TTL both extends a stolen token's window
        // of use and delays how fast a role change (e.g. a promotion being
        // undone) actually takes effect. Default dropped from 1d to 15m;
        // the refresh-token flow (with rotation + reuse detection already
        // implemented in AuthService.refresh()) is what should carry
        // session longevity, not the access token itself.
        JWT_EXPIRES_IN: Joi.string().default('15m'),

        // Dedicated refresh-token secret/TTL so a
        // leaked access-token secret can't be used to
        // forge refresh tokens. Strongly recommended in
        // production; falls back to JWT_SECRET/7d if unset.
        // FIX (weakness review #weak-jwt-secret): same 32-byte floor as
        // JWT_SECRET — this key protects both refresh-token forgery and
        // the invite/promotion token HMAC (via jwt.inviteSecret's fallback
        // chain in AuthService.hashOpaqueToken()).
        JWT_REFRESH_SECRET: Joi.string().min(32).optional(),

        JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),

        // ─────────────────────────────────────
        // OTP
        // ─────────────────────────────────────

        OTP_EXPIRES_IN_MINUTES: Joi.number().default(10),

        // Minimum time between OTP resends for the same purpose/user,
        // enforced in AuthService.issueAndSendOtp().
        OTP_RESEND_COOLDOWN_SECONDS: Joi.number().default(60),

        // ─────────────────────────────────────
        // SECURITY — LOGIN LOCKOUT
        //
        // Enforced in AuthService.recordFailedLogin() /
        // assertNotLocked(), used by both login() and adminLogin().
        // ─────────────────────────────────────

        MAX_LOGIN_ATTEMPTS: Joi.number().default(5),

        LOCKOUT_DURATION_MINUTES: Joi.number().default(15),

        // ─────────────────────────────────────
        // SECURITY — ENCRYPTION
        //
        // Maps to security.encryptionKey / security.encryptionIv in
        // configuration.ts. Currently unused — no code in the
        // codebase reads these values yet (confirmed via grep).
        // Kept optional so they're ready to wire up later without
        // blocking boot in the meantime. Tighten back to .required()
        // once something actually consumes them, and confirm the
        // real cipher's key/IV length requirements at that point.
        // ─────────────────────────────────────

        ENCRYPTION_KEY: Joi.string().optional(),

        ENCRYPTION_IV: Joi.string().optional(),

        // ─────────────────────────────────────
        // APP DEBUG
        //
        // Gates dev-only OTP console logging in AuthService.
        // MUST be false in production — leaving it true prints
        // real OTPs to server logs.
        // ─────────────────────────────────────

        APP_DEBUG: Joi.boolean()
          .default(false)
          .when('NODE_ENV', {
            is: 'production',
            then: Joi.valid(false),
            otherwise: Joi.optional(),
          }),

        // ─────────────────────────────────────
        // RATE LIMITING
        //
        // FIX (weakness review #trust-proxy): this global limit is only
        // meaningful now that main.ts sets `app.set('trust proxy', 1)` —
        // without that, every request behind the platform's load balancer
        // shared the same apparent IP, making this limit either useless
        // (a single shared bucket for all users) or trivially spoofable
        // via X-Forwarded-For.
        // ─────────────────────────────────────

        THROTTLE_TTL_SECONDS: Joi.number().default(60),

        THROTTLE_LIMIT: Joi.number().default(20),

        // ─────────────────────────────────────
        // SMS PROVIDER (SendET)
        //
        // Active provider — AfroMessage removed. Required (not optional)
        // since SendET is now the only SMS path; a missing/blank value
        // fails fast at boot instead of surfacing later as a runtime
        // "SendET API URL is not configured" error deep in a signup flow.
        // ─────────────────────────────────────

        SENDET_URL: Joi.string().uri().required(),

        SENDET_TOKEN: Joi.string().required(),

        SENDET_SENDER_NAME: Joi.string().optional(),

        SENDET_TIMEOUT_MS: Joi.number().default(10000),

        // ─────────────────────────────────────
        // MINIO
        //
        // ENDPOINT/ACCESS_KEY/SECRET_KEY/BUCKET_NAME were already required
        // here (unchanged) — good, that already fails fast at boot if
        // Cloudflare R2 credentials are missing in production.
        // ─────────────────────────────────────

        MINIO_ENDPOINT: Joi.string().required(),

        MINIO_PORT: Joi.number().default(9000),

        MINIO_ACCESS_KEY: Joi.string().required(),

        MINIO_SECRET_KEY: Joi.string().required(),

        MINIO_BUCKET_NAME: Joi.string().required(),

        MINIO_USE_SSL: Joi.boolean().default(false),

        // ADDED: was missing from this schema entirely, even though
        // configuration.ts now maps MINIO_REGION -> minio.region and
        // MinioService passes it to the Minio client constructor. Without
        // this entry, Joi's `allowUnknown: true` meant a typo'd or
        // unexpected value here would pass validation silently instead of
        // being checked at all. Default of 'us-east-1' is correct for
        // local MinIO; production (Render -> R2) must set
        // MINIO_REGION=auto explicitly via its own env var — not required
        // here since 'auto' is only the right value for one environment,
        // not a universal default.
        MINIO_REGION: Joi.string().default('us-east-1'),

        // FIX: previously read directly off process.env inside
        // MinioService with no validation at all — a non-numeric value
        // silently became NaN at request time instead of failing at boot
        // like every other misconfigured var here. Now validated and
        // mapped through configuration.ts as minio.presignDurationSeconds.
        // Default raised from 120 to 600 (10 min) to match the value
        // configuration.ts now falls back to. Keep this at a few minutes —
        // long TTLs mean a leaked/logged link to victim or missing-person
        // media stays live far longer than necessary.
        DURATION_OF_PRE_SIGNED_DOCUMENT: Joi.number().default(600),

        // ─────────────────────────────────────
        // MEDIA
        //
        // ADDED: read via ConfigService in PostService.validateMediaFilesExist()
        // but never declared here — same allowUnknown:true blind spot as
        // MINIO_REGION above. MEDIA_ALLOWED_MIME_TYPES must include
        // application/pdf (and any document types you accept) or the
        // CreatePostDto/UpdatePostDto pdf/document fields are unusable —
        // every attach attempt will fail content-type validation.
        // ─────────────────────────────────────

        MEDIA_MAX_FILE_SIZE: Joi.number().default(52_428_800),

        MEDIA_ALLOWED_MIME_TYPES: Joi.string().default(
          'image/jpeg,image/png,image/webp,video/mp4,audio/mpeg,application/pdf',
        ),

        // ─────────────────────────────────────
        // CONTENT SUBMISSION LIMITS / RETENTION
        //
        // ADDED: shared defaults used by every submission type (Reports,
        // Posts, Missing Person requests, Victim Profiles) rather than
        // Post-specific — same §33 "don't keep sensitive info longer than
        // necessary" reasoning applies to all of them equally. Each module
        // reads its own optional PREFIXED override first (POST_*, REPORT_*,
        // MISSING_PERSON_*, PROFILE_*) and falls back to these.
        //
        // The PREFIXED overrides are declared here too (as .optional()) so
        // a typo in one of them (e.g. POST_DRAFT_TTL_DAY, missing the S)
        // fails at boot instead of silently being ignored.
        // ─────────────────────────────────────

        CONTENT_MAX_PENDING_PER_USER: Joi.number().default(5),

        CONTENT_CREATE_RATE_LIMIT_WINDOW_SECONDS: Joi.number().default(60),

        CONTENT_DRAFT_TTL_DAYS: Joi.number().default(30),

        CONTENT_REJECTED_RETENTION_DAYS: Joi.number().default(90),

        CONTENT_STALE_PENDING_HOURS: Joi.number().default(48),

        // ADDED (item #13): shared attachment-count/total-size caps —
        // same cross-module reasoning as the rest of this block. Each
        // module reads its own optional PREFIXED override first.
        CONTENT_MAX_PHOTOS: Joi.number().default(5),

        CONTENT_MAX_VIDEOS: Joi.number().default(1),

        // Shared cap across audio + pdf + document + other combined —
        // none of those four individually needs its own limit yet.
        CONTENT_MAX_OTHER_FILES: Joi.number().default(2),

        // Total bytes across every attached file on one record.
        CONTENT_MAX_TOTAL_UPLOAD_BYTES: Joi.number().default(52_428_800), // 50MB

        // ADDED (item #21): shared automatic-flag thresholds. Flag only —
        // never auto-rejects or blocks anything on its own.
        CONTENT_AUTO_FLAG_REJECTION_COUNT: Joi.number().default(3),

        CONTENT_AUTO_FLAG_WINDOW_DAYS: Joi.number().default(7),

        // ── Post-specific overrides for the shared CONTENT_* keys ──

        POST_MAX_PENDING_PER_USER: Joi.number().optional(),

        POST_CREATE_RATE_LIMIT_WINDOW_SECONDS: Joi.number().optional(),

        POST_DRAFT_TTL_DAYS: Joi.number().optional(),

        POST_REJECTED_RETENTION_DAYS: Joi.number().optional(),

        POST_STALE_PENDING_HOURS: Joi.number().optional(),

        // ADDED — Post-specific overrides for the new shared keys above.
        POST_MAX_PHOTOS: Joi.number().optional(),

        POST_MAX_VIDEOS: Joi.number().optional(),

        POST_MAX_OTHER_FILES: Joi.number().optional(),

        POST_MAX_TOTAL_UPLOAD_BYTES: Joi.number().optional(),

        POST_AUTO_FLAG_REJECTION_COUNT: Joi.number().optional(),

        POST_AUTO_FLAG_WINDOW_DAYS: Joi.number().optional(),

        // ── Report-specific overrides for the shared CONTENT_* keys ──
        //
        // ADDED: mirrors the POST_* block above exactly — same
        // allowUnknown:true blind-spot reasoning. Reports DO support a
        // draft-like pre-submission state, so REPORT_DRAFT_TTL_DAYS is
        // included; drop it if that turns out not to be true of your
        // actual Report status model.

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

        // ── Missing Person-specific overrides for the shared CONTENT_* keys ──
        //
        // ADDED: no MISSING_PERSON_DRAFT_TTL_DAYS entry — Missing Person
        // requests have no draft concept in the PRD as currently
        // understood, so a draft-TTL override would be a dead config key.
        // Add it back in if that assumption turns out to be wrong.

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

        // ── Victim Profile-specific overrides for the shared CONTENT_* keys ──
        //
        // ADDED: same reasoning as Missing Person above — no
        // PROFILE_DRAFT_TTL_DAYS unless Victim Profiles turn out to have
        // a real draft status distinct from PENDING.

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

        // ─────────────────────────────────────
        // EMAIL / SMTP
        //
        // Consumed by common/email/email.config.ts and
        // common/email/email.service.ts. Required so a
        // missing SMTP config fails fast at boot instead
        // of only surfacing the first time an OTP or admin
        // invite email is sent.
        // ─────────────────────────────────────

        SMTP_HOST: Joi.string().required(),

        SMTP_PORT: Joi.number().default(587),

        SMTP_SECURE: Joi.boolean().default(false),

        SMTP_USER: Joi.string().required(),

        SMTP_PASSWORD: Joi.string().required(),

        SMTP_FROM: Joi.string().optional(),

        SMTP_FROM_NAME: Joi.string().default('Ehte'),
      }),

      validationOptions: {
        // Report every invalid/missing env var at
        // once instead of stopping at the first one —
        // much faster to fix a multi-variable
        // misconfiguration this way.
        abortEarly: false,
        allowUnknown: true,
      },
    }),

    // ─────────────────────────────────────────
    // EVENT SYSTEM
    //
    // Allows Core services to emit events
    // and Misc listeners to receive them.
    //
    // Example:
    //
    // ReportService
    //      ↓
    // eventEmitter.emit(...)
    //      ↓
    // AuditLogListener
    // NotificationListener
    //
    // ─────────────────────────────────────────

    EventEmitterModule.forRoot(),

    // ─────────────────────────────────────────
    // SCHEDULING
    //
    // Enables @Cron(...) app-wide — required by
    // PostRetentionService (draft TTL / rejected
    // retention sweeps) and any future scheduled job.
    // Registered once, globally, here.
    // ─────────────────────────────────────────

    ScheduleModule.forRoot(),

    // ─────────────────────────────────────────
    // RATE LIMITING
    //
    // Applied globally via APP_GUARD below.
    // Auth-sensitive endpoints (login, OTP
    // send/verify/resend, forgot-password) should
    // additionally set a tighter, endpoint-specific
    // @Throttle() override in AuthController, since
    // this default is app-wide and fairly generous.
    //
    // NOTE: this remains IP-keyed only (per-account throttling for a
    // single targeted phone/email across many source IPs is a separate,
    // not-yet-implemented gap — see the auth weakness review).
    // ─────────────────────────────────────────

    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],

      inject: [ConfigService],

      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get<number>('THROTTLE_TTL_SECONDS', 60) * 1000,

            limit: config.get<number>('THROTTLE_LIMIT', 20),
          },
        ],
      }),
    }),

    // ─────────────────────────────────────────
    // PASSPORT
    // ─────────────────────────────────────────

    PassportModule,

    // ─────────────────────────────────────────
    // JWT
    //
    // signOptions.expiresIn is deliberately NOT set here. Every
    // JwtService.sign() call in AuthService.issueTokens() passes its
    // own explicit `expiresIn` (and, for refresh tokens, its own
    // `secret`) — per-call options always override a module-level
    // default, so a signOptions default here would never actually
    // apply. Access-token TTL is controlled solely by
    // jwt.expiresIn (JWT_EXPIRES_IN, now defaulting to 15m) as read
    // in AuthService.
    // ─────────────────────────────────────

    JwtModule.registerAsync({
      imports: [ConfigModule],

      inject: [ConfigService],

      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('jwt.secret'),
      }),
    }),

    // ─────────────────────────────────────────
    // DATABASE
    // ─────────────────────────────────────────

    PrismaModule,

    // ─────────────────────────────────────────
    // LOGGER
    // ─────────────────────────────────────────

    AppLoggerModule,

    // ─────────────────────────────────────────
    // MINIO
    // ─────────────────────────────────────────

    MinioModule,

    // ─────────────────────────────────────────
    // EMAIL
    // ─────────────────────────────────────────

    EmailModule,

    // ─────────────────────────────────────────
    // AUTHENTICATION
    // ─────────────────────────────────────────

    AuthModule,

    // ─────────────────────────────────────────
    // CORE FEATURES
    //
    // Includes PostModule (User / Report / Post / Missing Person /
    // Information Submission / Victim Profile / Support). Confirm
    // PostRetentionService is listed in PostModule's own `providers`
    // array — registering ScheduleModule here only makes @Cron work,
    // it doesn't instantiate the service itself.
    // ─────────────────────────────────────────

    CoreModule,

    // ─────────────────────────────────────────
    // MEDIA
    //
    // Presigned-upload + delete-by-key endpoints only.
    // Standalone: no other module needs to import this one,
    // since MinioService is @Global().
    // ─────────────────────────────────────────

    MediaModule,

    // ─────────────────────────────────────────
    // MISC / SYSTEM FEATURES
    //
    // Audit Logs
    // Notifications
    // ─────────────────────────────────────────

    MiscModule,
  ],

  controllers: [],

  providers: [
    // ─────────────────────────────────────────
    // JWT STRATEGY
    // ─────────────────────────────────────────

    JwtStrategy,

    // ─────────────────────────────────────────
    // RE-AUTHENTICATION SERVICE
    // ─────────────────────────────────────────

    ReauthService,

    // ─────────────────────────────────────────
    // GLOBAL RATE-LIMIT GUARD
    //
    // Registered first so throttling is evaluated
    // before auth/roles logic runs on every request.
    // ─────────────────────────────────────────

    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },

    // ─────────────────────────────────────────
    // GLOBAL AUTHENTICATION GUARD
    // ─────────────────────────────────────────

    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },

    // ─────────────────────────────────────────
    // GLOBAL RE-AUTHENTICATION GUARD
    //
    // Runs after JwtAuthGuard (needs request.user)
    // and before RolesGuard. Only activates on
    // endpoints using @RequireReauthentication().
    // ─────────────────────────────────────────

    {
      provide: APP_GUARD,
      useClass: ReauthGuard,
    },

    // ─────────────────────────────────────────
    // GLOBAL ROLES GUARD
    //
    // Order is load-bearing: this must run AFTER
    // JwtAuthGuard, since it depends on
    // request.user already being populated.
    // ─────────────────────────────────────────

    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },

    // ─────────────────────────────────────────
    // GLOBAL PERMISSIONS GUARD
    //
    // Order is load-bearing: runs AFTER RolesGuard.
    // RolesGuard gets a caller in the door for a
    // resource (coarse-grained); PermissionsGuard then
    // decides exactly what they're allowed to do to it
    // (fine-grained), via @RequirePermissions(...).
    // Requires request.user.permissions, populated by
    // JwtStrategy.validate() from the JWT payload that
    // AuthService.issueTokens() now bakes in alongside
    // roles (see AuthService.derivePermissions()).
    // ─────────────────────────────────────

    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },

    // ─────────────────────────────────────────
    // SEEDERS
    // ─────────────────────────────────────────

    RolesSeeder,

    PermissionsSeeder,

    AdminSeeder,
  ],
})
export class AppModule {}