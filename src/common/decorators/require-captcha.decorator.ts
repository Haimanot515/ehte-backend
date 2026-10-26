import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiForbiddenResponse, ApiHeader } from '@nestjs/swagger';
import { TurnstileGuard } from '../guards/turnstile.guard';

/** Put on a route to require a valid Cloudflare Turnstile token (header: x-captcha-token). */
export const RequireCaptcha = () =>
  applyDecorators(
    UseGuards(TurnstileGuard),
    ApiHeader({
      name: 'x-captcha-token',
      required: false,
      description:
        'Cloudflare Turnstile token. Required when TURNSTILE_ENABLED=true. ' +
        'For dev/staging use the Cloudflare test secret 1x0000000000000000000000000000000AA with any dummy token.',
    }),
    ApiForbiddenResponse({ description: 'captcha_required or captcha_failed' }),
  );
