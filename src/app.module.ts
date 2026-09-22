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
import { AppLoggerModule } from './common/logger/logger.module';
import { RequestContextModule } from './common/request-context/request-context.module';
import { EmailModule } from './services/email/email.module';

import { CoreModule } from './modules/core/core.module';

import { MediaModule } from './modules/media/media.module';

import { MiscModule } from './modules/misc/misc.module';

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

        OTP_EXPIRES_IN_MINUTES: Joi.number().default(10),
        OTP_RESEND_COOLDOWN_SECONDS: Joi.number().default(60),

        MAX_LOGIN_ATTEMPTS: Joi.number().default(5),
        LOCKOUT_DURATION_MINUTES: Joi.number().default(15),

        ENCRYPTION_KEY: Joi.string().optional(),
        ENCRYPTION_IV: Joi.string().optional(),

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
        FIREBASE_PROJECT_ID: Joi.string().optional(),
        FIREBASE_CLIENT_EMAIL: Joi.string().optional(),
        FIREBASE_PRIVATE_KEY: Joi.string().optional(),

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
      }),

      validationOptions: {
        abortEarly: false,
        allowUnknown: true,
      },
    }),

    EventEmitterModule.forRoot(),

    ScheduleModule.forRoot(),

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

    MediaModule,

    MiscModule,
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
  ],
})
export class AppModule {}