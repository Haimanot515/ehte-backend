import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OAuth2Client } from 'google-auth-library';
import verifyAppleToken from 'verify-apple-id-token';

export type SocialProfile = {
  providerId: string;
  email: string;
  emailVerified: boolean;
  name?: string;
};

@Injectable()
export class SocialAuthUtil {
  private readonly logger = new Logger(SocialAuthUtil.name);
  private readonly googleClient: OAuth2Client;

  constructor(private readonly configService: ConfigService) {
    this.googleClient = new OAuth2Client(this.configService.get<string>('google.clientId'));
  }

  async verifyGoogleIdToken(idToken: string): Promise<SocialProfile> {
    const audience = this.configService.getOrThrow<string>('google.clientId');

    let payload;
    try {
      const ticket = await this.googleClient.verifyIdToken({ idToken, audience });
      payload = ticket.getPayload();
    } catch (error) {
      this.logger.warn(
        `Google ID token verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new UnauthorizedException('invalid_google_token');
    }

    if (!payload?.sub || !payload.email) {
      throw new UnauthorizedException('invalid_google_token');
    }

    return {
      providerId: payload.sub,
      email: payload.email.toLowerCase(),
      emailVerified: payload.email_verified ?? false,
      name: payload.name,
    };
  }

  async verifyFacebookAccessToken(accessToken: string): Promise<SocialProfile> {
    const appId = this.configService.getOrThrow<string>('facebook.appId');
    const appSecret = this.configService.getOrThrow<string>('facebook.appSecret');

    let tokenData: { is_valid?: boolean; app_id?: string } | undefined;

    try {
      const debugRes = await fetch(
        `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${appId}|${appSecret}`,
      );
      const debugBody = await debugRes.json();
      tokenData = debugBody?.data;
    } catch (error) {
      this.logger.warn(
        `Facebook debug_token call failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new UnauthorizedException('invalid_facebook_token');
    }

    if (!tokenData?.is_valid || tokenData.app_id !== appId) {
      throw new UnauthorizedException('invalid_facebook_token');
    }

    let profile: { id?: string; name?: string; email?: string } | undefined;

    try {
      const profileRes = await fetch(
        `https://graph.facebook.com/v19.0/me?fields=id,name,email&access_token=${encodeURIComponent(accessToken)}`,
      );
      profile = await profileRes.json();
    } catch (error) {
      this.logger.warn(
        `Facebook profile fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new UnauthorizedException('invalid_facebook_token');
    }

    if (!profile?.id || !profile.email) {
      throw new UnauthorizedException('facebook_email_required');
    }

    return {
      providerId: profile.id,
      email: profile.email.toLowerCase(),
      emailVerified: true,
      name: profile.name,
    };
  }

  async verifyAppleIdToken(idToken: string, nameFromClient?: string): Promise<SocialProfile> {
    const clientId = this.configService.getOrThrow<string>('apple.clientId');

    let claims;
    try {
      claims = await verifyAppleToken({ idToken, clientId });
    } catch (error) {
      this.logger.warn(
        `Apple ID token verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new UnauthorizedException('invalid_apple_token');
    }

    if (!claims?.sub || !claims.email) {
      throw new UnauthorizedException('invalid_apple_token');
    }

    return {
      providerId: claims.sub,
      email: claims.email.toLowerCase(),
      emailVerified: claims.email_verified === true || String(claims.email_verified) === 'true',
      name: nameFromClient,
    };
  }
}
