import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'crypto';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',

        transport:
          process.env.NODE_ENV !== 'production'
            ? {
                target: 'pino-pretty',
                options: {
                  singleLine: true,
                  colorize: true,
                },
              }
            : undefined,

        autoLogging: true,

        genReqId: (req) => (req.headers['x-request-id'] as string) || randomUUID(),

        // Never write credentials to logs (Dozzle, files, log shippers).
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.headers["x-api-key"]',
            'res.headers["set-cookie"]',
            'req.body.password',
            'req.body.currentPassword',
            'req.body.newPassword',
            'req.body.refreshToken',
            'req.body.otp',
          ],
          censor: '[REDACTED]',
        },

        // Log only what is useful instead of dumping every header.
        serializers: {
          req: (req) => ({
            id: req.id,
            method: req.method,
            url: req.url,
            remoteAddress: req.remoteAddress,
          }),
          res: (res) => ({ statusCode: res.statusCode }),
        },

        // 4xx -> warn, 5xx/errors -> error (they were all logged at info level).
        customLogLevel: (_req, res, err) => {
          if (err || res.statusCode >= 500) return 'error';
          if (res.statusCode >= 400) return 'warn';
          return 'info';
        },
      },
    }),
  ],

  exports: [LoggerModule],
})
export class AppLoggerModule {}