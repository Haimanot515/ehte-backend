import { SetMetadata } from '@nestjs/common';

export const REQUIRE_REAUTH_KEY = 'requireReauth';

export const RequireReauthentication = () => SetMetadata(REQUIRE_REAUTH_KEY, true);
