import { Module } from '@nestjs/common';
import {
  ConfigModule,
  ConfigService,
} from '@nestjs/config';

import * as Joi from 'joi';

import {
  APP_GUARD,
} from '@nestjs/core';

import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { EventEmitterModule } from '@nestjs/event-emitter';

// ─────────────────────────────────────────────
// RATE LIMITING
//
// npm i @nestjs/throttler
// ─────────────────────────────────────────────

import {
  ThrottlerModule,
  ThrottlerGuard,
} from '@nestjs/throttler';

// ─────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────

import configuration from './config/configuration';
import minioConfig from './config/minio.config';

// ─────────────────────────────────────────────
// CORE / INFRASTRUCTURE MODULES
// ─────────────────────────────────────────────

import { PrismaModule } from './prisma/prisma.module';
import { MinioModule } from './common/minio/minio.module';
import { AppLoggerModule } from './common/logger/logger.module';

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

// ─────────────────────────────────────────────
// SEEDERS
// ─────────────────────────────────────────────

import { AdminSeeder } from './common/seed/admin.seeder';
import { RolesSeeder } from './common/seed/roles.seeder';

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

      envFilePath: [
        `.env.${process.env.NODE_ENV}`,
        '.env',
      ],

      load: [
        configuration,
        minioConfig,
      ],

      validationSchema: Joi.object({

        NODE_ENV: Joi.string()
          .valid(
            'development',
            'test',
            'production',
          )
          .default('development'),

        PORT: Joi.number()
          .default(3000),

        APP_NAME: Joi.string()
          .default('Ehte'),

        // CORS_ORIGIN may be a single origin or a
        // comma-separated list ("https://a.com,https://b.com").
        // main.ts splits this into an array before
        // passing it to enableCors().
        CORS_ORIGIN: Joi.string()
          .required(),

        CORS_CREDENTIALS: Joi.boolean()
          .default(true),

        SWAGGER_ENABLED: Joi.boolean()
          .default(true),

        // Optional basic-auth credentials protecting
        // the /docs route in non-production environments
        // that are still externally reachable. If either
        // is unset, /docs is left unprotected (fine for
        // fully-local dev, not fine for a shared staging
        // deployment).
        SWAGGER_USER: Joi.string()
          .optional(),

        SWAGGER_PASSWORD: Joi.string()
          .optional(),

        DATABASE_URL: Joi.string()
          .required(),

        // Set to "false" to skip running
        // `prisma migrate deploy` on boot — use this
        // on every replica except the one designated
        // to run migrations (or run migrations via a
        // separate one-off job/init container instead).
        RUN_MIGRATIONS: Joi.boolean()
          .default(true),

        // ─────────────────────────────────────
        // JWT
        // ─────────────────────────────────────

        JWT_SECRET: Joi.string()
          .min(10)
          .required(),

        JWT_EXPIRES_IN: Joi.string()
          .default('1d'),

        // Dedicated refresh-token secret/TTL so a
        // leaked access-token secret can't be used to
        // forge refresh tokens. Strongly recommended in
        // production; falls back to JWT_SECRET/7d if unset.
        JWT_REFRESH_SECRET: Joi.string()
          .min(10)
          .optional(),

        JWT_REFRESH_EXPIRES_IN: Joi.string()
          .default('7d'),

        // ─────────────────────────────────────
        // OTP
        // ─────────────────────────────────────

        OTP_EXPIRES_IN_MINUTES: Joi.number()
          .default(10),

        // ─────────────────────────────────────
        // RATE LIMITING
        // ─────────────────────────────────────

        THROTTLE_TTL_SECONDS: Joi.number()
          .default(60),

        THROTTLE_LIMIT: Joi.number()
          .default(20),

        // ─────────────────────────────────────
        // SMS PROVIDER (Afromessage)
        // ─────────────────────────────────────

        AFROMESSAGE_URL: Joi.string()
          .uri()
          .required(),

        AFROMESSAGE_TOKEN: Joi.string()
          .required(),

        AFROMESSAGE_IDENTIFIER_ID: Joi.string()
          .required(),

        AFROMESSAGE_SENDER_NAME: Joi.string()
          .optional(),

        // ─────────────────────────────────────
        // MINIO
        // ─────────────────────────────────────

        MINIO_ENDPOINT: Joi.string()
          .required(),

        MINIO_PORT: Joi.number()
          .default(9000),

        MINIO_ACCESS_KEY: Joi.string()
          .required(),

        MINIO_SECRET_KEY: Joi.string()
          .required(),

        MINIO_BUCKET: Joi.string()
          .required(),
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
    // RATE LIMITING
    //
    // Applied globally via APP_GUARD below.
    // Auth-sensitive endpoints (login, OTP
    // send/verify/resend, forgot-password) should
    // additionally set a tighter, endpoint-specific
    // @Throttle() override in AuthController, since
    // this default is app-wide and fairly generous.
    // ─────────────────────────────────────────

    ThrottlerModule.forRootAsync({
      imports: [
        ConfigModule,
      ],

      inject: [
        ConfigService,
      ],

      useFactory: (
        config: ConfigService,
      ) => ({
        throttlers: [
          {
            ttl:
              config.get<number>(
                'THROTTLE_TTL_SECONDS',
                60,
              ) * 1000,

            limit:
              config.get<number>(
                'THROTTLE_LIMIT',
                20,
              ),
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
    // ─────────────────────────────────────────

    JwtModule.registerAsync({
      imports: [
        ConfigModule,
      ],

      inject: [
        ConfigService,
      ],

      useFactory: (
        config: ConfigService,
      ) => ({
        secret:
          config.getOrThrow<string>(
            'jwt.secret',
          ),

        signOptions: {
          expiresIn:
            config.get(
              'jwt.expiresIn',
              '1d',
            ) as any,
        },
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
    // AUTHENTICATION
    // ─────────────────────────────────────────

    AuthModule,

    // ─────────────────────────────────────────
    // CORE FEATURES
    // ─────────────────────────────────────────

    CoreModule,

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
    // SEEDERS
    // ─────────────────────────────────────────

    RolesSeeder,

    AdminSeeder,
  ],
})
export class AppModule {}