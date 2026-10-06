import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isIP } from 'net';
import { AsnResponse, CityResponse, Reader, open } from 'maxmind';

export interface GeoInfo {
  country?: string;
  city?: string;
  region?: string;
  timezone?: string;
  asn?: number;
  isp?: string;
}

@Injectable()
export class GeoLookupService implements OnModuleInit {
  private readonly logger = new Logger(GeoLookupService.name);
  private cityReader?: Reader<CityResponse>;
  private asnReader?: Reader<AsnResponse>;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const cityPath = this.config.get<string>('geo.cityDbPath');
    const asnPath = this.config.get<string>('geo.asnDbPath');

    if (cityPath) {
      try {
        this.cityReader = await open<CityResponse>(cityPath);
        this.logger.log('GeoIP city database loaded');
      } catch (error) {
        // A missing database must never stop the API from starting
        this.logger.error(`GeoIP city database failed to load: ${(error as Error).message}`);
      }
    }

    if (asnPath) {
      try {
        this.asnReader = await open<AsnResponse>(asnPath);
        this.logger.log('GeoIP ASN database loaded');
      } catch (error) {
        this.logger.error(`GeoIP ASN database failed to load: ${(error as Error).message}`);
      }
    }

    if (!cityPath && !asnPath) {
      this.logger.warn('No GeoIP database configured: audit rows will have no IP location');
    }
  }

  // Never throws: a failed lookup returns an empty object
  lookup(rawIp?: string | null): GeoInfo {
    const ip = this.normalizeIp(rawIp);
    if (!ip) return {};

    const info: GeoInfo = {};

    try {
      const city = this.cityReader?.get(ip);
      if (city) {
        info.country = city.country?.iso_code ?? undefined;
        info.city = city.city?.names?.en ?? undefined;
        info.region = city.subdivisions?.[0]?.names?.en ?? undefined;
        info.timezone = city.location?.time_zone ?? undefined;
      }
    } catch {
      // ignore: the lookup is best effort
    }

    try {
      const asn = this.asnReader?.get(ip);
      if (asn) {
        info.asn = asn.autonomous_system_number ?? undefined;
        info.isp = asn.autonomous_system_organization ?? undefined;
      }
    } catch {
      // ignore: the lookup is best effort
    }

    return info;
  }

  // Strips the IPv4-mapped IPv6 prefix and rejects anything that is not an IP
  private normalizeIp(raw?: string | null): string | null {
    if (!raw) return null;
    const ip = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
    return isIP(ip) ? ip : null;
  }
}