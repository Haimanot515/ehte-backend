import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiHeader, ApiUnauthorizedResponse } from '@nestjs/swagger';

export const REQUIRE_REAUTH_KEY = 'requireReauth';

// Header the ReauthGuard reads the credential from. Works for every HTTP method
// (GET/DELETE have no body) and for multipart uploads, where the guard runs before
// the body is parsed. The guard also still accepts body.credential on JSON bodies.
export const REAUTH_CREDENTIAL_HEADER = 'X-Reauth-Credential';

// Marks an endpoint as requiring re-authentication AND documents the credential
// header in Swagger, so it shows up as an input field when testing the endpoint.
export const RequireReauthentication = () =>
  applyDecorators(
    SetMetadata(REQUIRE_REAUTH_KEY, true),
    ApiHeader({
      name: REAUTH_CREDENTIAL_HEADER,
      required: true,
      description:
        'Re-authentication: your account password (or your Discreet Mode passcode, if enabled). Required to confirm this sensitive action.',
      schema: { type: 'string', format: 'password' },
    }),
    ApiUnauthorizedResponse({
      description:
        'reauthentication_required (credential missing), invalid_credential (wrong), or reauthentication_locked (too many failed attempts).',
    }),
  );
