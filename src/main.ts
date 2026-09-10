import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder, SwaggerCustomOptions } from '@nestjs/swagger';
import { NestExpressApplication } from '@nestjs/platform-express';
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

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

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

  // FIX (weakness review #trust-proxy): without this, Express/Nest sees every
  // request as originating from Render's (or any) reverse proxy, not the real
  // client. ThrottlerGuard's per-IP limiting keys off req.ip — with trust proxy
  // unset that's either the proxy's single IP for everyone (one shared bucket,
  // effectively breaking rate limiting for all users at once) or spoofable via
  // X-Forwarded-For (an attacker sets their own IP header and gets a fresh
  // bucket on every request). `1` trusts exactly one hop (the platform's own
  // load balancer) — adjust if there's an additional proxy layer in front of it.
  app.set('trust proxy', 1);

  // FIX (weakness review #cors-wildcard-credentials): origin: '*' combined with
  // credentials: true is a known misconfiguration pattern — most browsers will
  // refuse to honor it, but it's a signal something is set up wrong, and some
  // non-browser HTTP clients don't enforce the restriction at all. Fail fast
  // instead of shipping a CORS policy that's either broken or unintentionally
  // permissive.
  if (corsCredentials && corsOrigin.includes('*')) {
    throw new Error(
      '[EHTE] CORS_ORIGIN cannot include "*" while CORS_CREDENTIALS is true. ' +
        'List explicit allowed origins instead.',
    );
  }

  // ─────────────────────────────────────────────
  // SWAGGER CONFIGURATION
  // ─────────────────────────────────────────────

  const swaggerEnabled = configService.get<boolean>('swagger.enabled') ?? false;

  const swaggerUser = configService.get<string>('SWAGGER_USER');

  const swaggerPassword = configService.get<string>('SWAGGER_PASSWORD');

  const shouldEnableSwagger = swaggerEnabled;

  // FIX (weakness review #swagger-unprotected): previously an enabled-but-
  // uncredentialed Swagger config only logged a warning and still served
  // /docs openly — easy to miss in deploy logs. Now this fails startup
  // outright in any environment other than plain local development, so a
  // misconfigured staging/production deploy can't silently expose the full
  // API surface (including auth flows) to anyone who finds the URL.
  if (shouldEnableSwagger && nodeEnv !== 'development' && (!swaggerUser || !swaggerPassword)) {
    throw new Error(
      `[EHTE] Swagger is enabled in "${nodeEnv}" but SWAGGER_USER/SWAGGER_PASSWORD are not ` +
        'configured. Set both, or disable Swagger via SWAGGER_ENABLED=false for this environment.',
    );
  }

  // Public URL of this deployment (e.g. https://ehte-api.onrender.com), set on Render's
  // Environment tab. Falls back to localhost when not set (local dev).
  const publicUrl = configService.get<string>('APP_URL');

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

  // FIX (weakness review #csp-disabled): contentSecurityPolicy: false turns
  // the header off entirely rather than tuning it, which drops a real
  // defense-in-depth layer against injected-script/XSS-style payloads
  // reflected anywhere in the app. Swagger UI needs a handful of relaxed
  // directives (inline styles/scripts, its own assets) to render, so those
  // are scoped narrowly instead of disabling CSP app-wide. Tighten further
  // (e.g. drop 'unsafe-inline') if/when Swagger UI is served from behind an
  // asset pipeline that supports nonces.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: [`'self'`],
          scriptSrc: [`'self'`, `'unsafe-inline'`],
          styleSrc: [`'self'`, `'unsafe-inline'`],
          imgSrc: [`'self'`, 'data:', 'https:'],
          connectSrc: [`'self'`],
          objectSrc: [`'none'`],
          frameAncestors: [`'none'`],
        },
      },
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
      // Reachable only in local development now — the startup check above
      // throws for every other environment before we get here.
      logger.warn(
        `Swagger is enabled but SWAGGER_USER/SWAGGER_PASSWORD are not configured. /docs is UNPROTECTED. Environment: ${nodeEnv}`,
      );
    }

    // ───────────────────────────────────────────
    // SWAGGER CONFIG
    // ───────────────────────────────────────────

    const swaggerConfigBuilder = new DocumentBuilder()
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
      );

    // SERVERS: register whichever host is actually reachable from the
    // browser viewing these docs, so "Execute" never targets the wrong
    // origin. Local dev sees localhost first; a deployed environment
    // (Render etc.) sees its own public URL first, with localhost kept
    // as a secondary option for anyone tunnelling/proxying locally.

    if (nodeEnv === 'production' && publicUrl) {
      swaggerConfigBuilder.addServer(publicUrl, 'Production');
      swaggerConfigBuilder.addServer('http://localhost:3000', 'Local Development');
    } else {
      swaggerConfigBuilder.addServer('http://localhost:3000', 'Local Development');
      if (publicUrl) {
        swaggerConfigBuilder.addServer(publicUrl, 'Deployed');
      }
    }

    // TAG ORDER
    swaggerConfigBuilder
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
      .addTag('Audit Logs');

    const swaggerConfig = swaggerConfigBuilder.build();

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