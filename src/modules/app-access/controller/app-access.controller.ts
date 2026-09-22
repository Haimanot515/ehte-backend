import { Controller, Get, Headers, Res, VERSION_NEUTRAL } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Response } from 'express';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';

// Public smart-redirect endpoint the Ehte QR code points to. No Swagger
// tags/operations — this is not a documented API contract, just a
// device-detecting redirect, so it stays excluded from /docs like the
// rest of the QR/app-access surface.
@ApiExcludeController()
@AllowAnonymous()
@Throttle({ default: { limit: 120, ttl: 60000 } })
@Controller({ path: 'app', version: VERSION_NEUTRAL })
export class AppAccessController {
  constructor(private readonly config: ConfigService) {}

  @Get()
  redirect(@Headers('user-agent') userAgent = '', @Res() res: Response): void {
    const androidUrl = this.config.getOrThrow<string>('ANDROID_STORE_URL');
    const iosUrl = this.config.getOrThrow<string>('IOS_STORE_URL');

    res.setHeader('Cache-Control', 'no-store');

    if (/android/i.test(userAgent)) {
      res.redirect(302, androidUrl);
      return;
    }

    if (/iphone|ipad|ipod/i.test(userAgent)) {
      res.redirect(302, iosUrl);
      return;
    }

    res.status(200).type('html').send(this.fallbackPage(androidUrl, iosUrl));
  }

  private fallbackPage(androidUrl: string, iosUrl: string): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ehte</title>
</head>
<body style="font-family: sans-serif; text-align: center; padding: 3rem 1rem;">
  <h1>Ehte</h1>
  <p>Ehte is a mobile application. Choose your app store:</p>
  <p><a href="${androidUrl}">Google Play</a></p>
  <p><a href="${iosUrl}">App Store</a></p>
</body>
</html>`;
  }
}
