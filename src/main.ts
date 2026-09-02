import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder, SwaggerCustomOptions } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import { json, urlencoded } from 'express';
import basicAuth from 'express-basic-auth';
import { Logger } from 'nestjs-pino';
import { execSync } from 'child_process';

import { GlobalExceptionFilter } from './common/filters/http-exception.filter';
import { ResponseInterceptor } from './common/interceptors/response.interceptor';

// ─────────────────────────────────────────────
// PROCESS-LEVEL SAFETY NETS
// ─────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('[EHTE] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[EHTE] Uncaught exception:', error);

  process.exit(1);
});

async function bootstrap() {
  // ─────────────────────────────────────────────
  // DATABASE MIGRATIONS
  // ─────────────────────────────────────────────

  if (process.env.RUN_MIGRATIONS !== 'false') {
    try {
      execSync('npx prisma migrate deploy --schema=./prisma/schema', {
        stdio: 'inherit',
      });
    } catch (error) {
      console.error('[EHTE] Database migration failed — aborting startup.', error);

      throw error;
    }
  }

  // ─────────────────────────────────────────────
  // CREATE APPLICATION
  // ─────────────────────────────────────────────

  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);

  // ─────────────────────────────────────────────
  // APPLICATION CONFIGURATION
  // ─────────────────────────────────────────────

  const port = configService.getOrThrow<number>('app.port');

  const appName = configService.getOrThrow<string>('app.name');

  const nodeEnv = configService.getOrThrow<string>('app.env');

  const corsOriginRaw = configService.getOrThrow<string>('cors.origin');

  const corsOrigin = corsOriginRaw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const corsCredentials = configService.getOrThrow<boolean>('cors.credentials');

  // ─────────────────────────────────────────────
  // SWAGGER CONFIGURATION
  // ─────────────────────────────────────────────

  const swaggerEnabled = configService.get<boolean>('swagger.enabled') ?? false;

  const swaggerUser = configService.get<string>('SWAGGER_USER');

  const swaggerPassword = configService.get<string>('SWAGGER_PASSWORD');

  const shouldEnableSwagger = swaggerEnabled;

  // ─────────────────────────────────────────────
  // LOGGER
  // ─────────────────────────────────────────────

  const logger = app.get(Logger);

  app.useLogger(logger);

  // ─────────────────────────────────────────────
  // GRACEFUL SHUTDOWN
  // ─────────────────────────────────────────────

  app.enableShutdownHooks();

  // ─────────────────────────────────────────────
  // API VERSIONING
  // ─────────────────────────────────────────────

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // ─────────────────────────────────────────────
  // SECURITY
  // ─────────────────────────────────────────────

  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );

  // ─────────────────────────────────────────────
  // COMPRESSION
  // ─────────────────────────────────────────────

  app.use(compression());

  // ─────────────────────────────────────────────
  // REQUEST BODY LIMITS
  // ─────────────────────────────────────────────

  app.use(
    json({
      limit: '10mb',
    }),
  );

  app.use(
    urlencoded({
      extended: true,
      limit: '10mb',
    }),
  );

  // ─────────────────────────────────────────────
  // CORS
  // ─────────────────────────────────────────────

  app.enableCors({
    origin: corsOrigin,
    credentials: corsCredentials,
  });

  // ─────────────────────────────────────────────
  // GLOBAL VALIDATION
  // ─────────────────────────────────────────────

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,

      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // ─────────────────────────────────────────────
  // GLOBAL EXCEPTION FILTER
  // ─────────────────────────────────────────────

  app.useGlobalFilters(new GlobalExceptionFilter());

  // ─────────────────────────────────────────────
  // GLOBAL RESPONSE INTERCEPTOR
  // ─────────────────────────────────────────────

  app.useGlobalInterceptors(new ResponseInterceptor());

  // ─────────────────────────────────────────────
  // SWAGGER DOCUMENTATION
  // ─────────────────────────────────────────────

  if (shouldEnableSwagger) {
    // ───────────────────────────────────────────
    // BASIC AUTH
    // ───────────────────────────────────────────

    if (swaggerUser && swaggerPassword) {
      app.use(
        '/docs',
        basicAuth({
          challenge: true,
          users: {
            [swaggerUser]: swaggerPassword,
          },
        }),
      );

      logger.log('Swagger Basic Authentication enabled');
    } else {
      logger.warn(
        `Swagger is enabled but SWAGGER_USER/SWAGGER_PASSWORD are not configured. /docs is UNPROTECTED. Environment: ${nodeEnv}`,
      );
    }

    // ───────────────────────────────────────────
    // SWAGGER CONFIG
    // ───────────────────────────────────────────

    const swaggerConfig = new DocumentBuilder()
      .setTitle('Ehte API')
      .setDescription(
        `
**Safe Reporting, Public Awareness, Missing Persons and Victim Support Platform**

Ehte provides secure APIs for:

- Authentication and authorization
- Anonymous and authenticated reporting
- Public awareness posts
- Missing person management
- Information submissions
- Victim and survivor support
- Financial support
- Notifications
- Security and audit logging

## API Version

**v1**

## Authentication

Most endpoints require a valid JWT access token.

Use the **Authorize** button and enter:

\`Bearer <access_token>\`
`,
      )
      .setVersion('1.0.0')
      .setContact('Pitron Technology Solutions', '', '')
      .setLicense('Proprietary', '')

      // JWT AUTHENTICATION
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your JWT access token',
        },
        'access-token',
      )

      // LOCAL SERVER
      .addServer('http://localhost:3000', 'Local Development')

      // TAG ORDER
      .addTag('Authentication')
      .addTag('Reports')
      .addTag('Posts')
      .addTag('Missing Persons')
      .addTag('Information Submissions')
      .addTag('Victim Profiles')
      .addTag('Support')
      .addTag('Notifications')
      .addTag('Users')
      .addTag('Roles')
      .addTag('Audit Logs')

      .build();

    // ───────────────────────────────────────────
    // CREATE SWAGGER DOCUMENT
    // ───────────────────────────────────────────

    const document = SwaggerModule.createDocument(app, swaggerConfig);

    // ───────────────────────────────────────────
    // SWAGGER UI OPTIONS
    // ───────────────────────────────────────────

    const customOptions: SwaggerCustomOptions = {
      customSiteTitle: 'Ehte API Documentation',

      customfavIcon: 'https://nestjs.com/img/logo-small.svg',

      swaggerOptions: {
        docExpansion: 'none',
        filter: true,
        persistAuthorization: true,
        displayRequestDuration: true,
        deepLinking: true,
        tryItOutEnabled: true,
        displayOperationId: false,
        defaultModelsExpandDepth: 1,
        defaultModelExpandDepth: 2,
        operationsSorter: 'alpha',
      },
    };

    // ───────────────────────────────────────────
    // SWAGGER SETUP
    // ───────────────────────────────────────────

    SwaggerModule.setup('docs', app, document, customOptions);

    logger.log(`Swagger documentation enabled at /docs [env: ${nodeEnv}]`);
  } else {
    logger.log(`Swagger documentation is disabled [env: ${nodeEnv}]`);
  }

  // ─────────────────────────────────────────────
  // START SERVER
  // ─────────────────────────────────────────────

  await app.listen(port);

  logger.log(`${appName} running on port ${port} [env: ${nodeEnv}]`);
}

bootstrap().catch((error) => {
  console.error('[EHTE] Fatal error during bootstrap — process will exit.', error);

  process.exit(1);
});
