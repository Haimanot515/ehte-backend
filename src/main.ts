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

process.on('unhandledRejection', (reason) => {
  console.error('[EHTE] Unhandled promise rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[EHTE] Uncaught exception:', error);
  process.exit(1);
});

async function bootstrap() {
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

  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const configService = app.get(ConfigService);

  const port = configService.getOrThrow<number>('app.port');
  const appName = configService.getOrThrow<string>('app.name');
  const nodeEnv = configService.getOrThrow<string>('app.env');

  const corsOriginRaw = configService.getOrThrow<string>('cors.origin');
  const corsOrigin = corsOriginRaw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const corsCredentials = configService.getOrThrow<boolean>('cors.credentials');

  app.set('trust proxy', 1);

  if (corsCredentials && corsOrigin.includes('*')) {
    throw new Error(
      '[EHTE] CORS_ORIGIN cannot include "*" while CORS_CREDENTIALS is true. ' +
        'List explicit allowed origins instead.',
    );
  }

  const swaggerEnabled = configService.get<boolean>('swagger.enabled') ?? false;
  const swaggerUser = configService.get<string>('SWAGGER_USER');
  const swaggerPassword = configService.get<string>('SWAGGER_PASSWORD');
  const shouldEnableSwagger = swaggerEnabled;

  if (shouldEnableSwagger && nodeEnv !== 'development' && (!swaggerUser || !swaggerPassword)) {
    throw new Error(
      `[EHTE] Swagger is enabled in "${nodeEnv}" but SWAGGER_USER/SWAGGER_PASSWORD are not ` +
        'configured. Set both, or disable Swagger via SWAGGER_ENABLED=false for this environment.',
    );
  }

  const publicUrl = configService.get<string>('APP_URL');

  const logger = app.get(Logger);
  app.useLogger(logger);

  app.enableShutdownHooks();

  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

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

  app.use(compression());

  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  app.enableCors({
    origin: corsOrigin,
    credentials: corsCredentials,
  });

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

  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  if (shouldEnableSwagger) {
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
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Enter your JWT access token',
        },
        'access-token',
      );

    if (nodeEnv === 'production' && publicUrl) {
      swaggerConfigBuilder.addServer(publicUrl, 'Production');
      swaggerConfigBuilder.addServer('http://localhost:3000', 'Local Development');
    } else {
      swaggerConfigBuilder.addServer('http://localhost:3000', 'Local Development');
      if (publicUrl) {
        swaggerConfigBuilder.addServer(publicUrl, 'Deployed');
      }
    }

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
      .addTag('Permissions')
      .addTag('Audit Logs');

    const swaggerConfig = swaggerConfigBuilder.build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);

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

    SwaggerModule.setup('docs', app, document, customOptions);

    logger.log(`Swagger documentation enabled at /docs [env: ${nodeEnv}]`);
  } else {
    logger.log(`Swagger documentation is disabled [env: ${nodeEnv}]`);
  }

  await app.listen(port);

  logger.log(`${appName} running on port ${port} [env: ${nodeEnv}]`);
}

bootstrap().catch((error) => {
  console.error('[EHTE] Fatal error during bootstrap — process will exit.', error);
  process.exit(1);
});
