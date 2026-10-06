import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, Report } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import {
  ReportMapQueryDto,
  NearbyReportsQueryDto,
  HotspotsQueryDto,
  AttachReportLocationDto,
  UpdateReportLocationDto,
} from '../dto/report.dto';
import { TERMINAL_STATUSES, REPORT_TABLE, act, RequestCtx } from './report.constants';
import { ReportCommonService } from './report-common.service';

@Injectable()
export class ReportLocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly reportCommonService: ReportCommonService,
  ) {}

  // GP-01 POST /reports/:id/location
  async attachLocation(user: CurrentUserDto, reportId: string, dto: AttachReportLocationDto) {
    const report = await this.reportCommonService.loadOwned(user, reportId);
    if (TERMINAL_STATUSES.includes(report.status)) {
      throw new BadRequestException('report_is_closed');
    }

    const updated = await this.prisma.report.update({
      where: { id: reportId },
      data: { ...this.reportCommonService.gpsData(dto.gps), lastActivityAt: new Date() },
    });

    this.reportCommonService.audit(user, act('REPORT_LOCATION_CHANGED'), report, {
      result: 'success',
      source: 'reporter',
      hadLocation: report.latitude != null,
    });

    return {
      id: updated.id,
      latitude: updated.latitude,
      longitude: updated.longitude,
      locationAccuracyMeters: updated.locationAccuracyMeters,
      locationCapturedAt: updated.locationCapturedAt,
      locationAddress: updated.locationAddress,
    };
  }

  // GP-09 GET /reports/:id/location   (REPORT_LOCATION_READ, audited)
  async getLocation(admin: CurrentUserDto, reportId: string, ctx?: RequestCtx) {
    const report = await this.reportCommonService.loadForAdmin(admin, reportId);

    await this.reportCommonService.logAccess(reportId, admin.id, 'LOCATION_VIEW', ctx);
    this.reportCommonService.audit(
      admin,
      act('REPORT_LOCATION_VIEWED'),
      report,
      {
        result: 'success',
        hasGps: report.latitude != null,
      },
      { targetUserId: report.isAnonymous ? null : report.userId },
    );

    return {
      id: report.id,
      location: report.location,
      latitude: report.latitude,
      longitude: report.longitude,
      accuracyMeters: report.locationAccuracyMeters,
      capturedAt: report.locationCapturedAt,
      address: report.locationAddress,
      verified: report.locationVerified,
      verifiedAt: report.locationVerifiedAt,
      verifiedById: report.locationVerifiedById,
      note: report.locationNote,
    };
  }

  // GP-10 PATCH /reports/:id/location   (correct and/or verify)
  async updateLocation(admin: CurrentUserDto, reportId: string, dto: UpdateReportLocationDto) {
    const existing = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_LOCATION_CHANGED'));

    if (!dto.gps && dto.verified === undefined && dto.note === undefined) {
      throw new BadRequestException('nothing_to_update');
    }
    const hasLocation = existing.latitude != null || !!dto.gps;
    if (dto.verified === true && !hasLocation)
      throw new BadRequestException('no_location_to_verify');

    const now = new Date();
    const data: Prisma.ReportUncheckedUpdateInput = { lastActivityAt: now };
    if (dto.gps) Object.assign(data, this.reportCommonService.gpsData(dto.gps));
    if (dto.verified !== undefined) {
      Object.assign(
        data,
        dto.verified
          ? { locationVerified: true, locationVerifiedAt: now, locationVerifiedById: admin.id }
          : { locationVerified: false, locationVerifiedAt: null, locationVerifiedById: null },
      );
    }
    if (dto.note !== undefined) data.locationNote = dto.note;

    const [report] = await this.prisma.$transaction([
      this.prisma.report.update({ where: { id: reportId }, data }),
      this.reportCommonService.revision(reportId, admin.id, {
        location: {
          from: {
            latitude: existing.latitude,
            longitude: existing.longitude,
            verified: existing.locationVerified,
          },
          to: {
            latitude: dto.gps?.latitude ?? existing.latitude,
            longitude: dto.gps?.longitude ?? existing.longitude,
            verified: dto.verified ?? existing.locationVerified,
          },
        },
        ...(dto.note ? { note: dto.note } : {}),
      }),
    ]);

    this.reportCommonService.audit(admin, act('REPORT_LOCATION_CHANGED'), report, {
      result: 'success',
      source: 'admin',
      corrected: !!dto.gps,
      verified: dto.verified ?? null,
    });
    return this.getLocationSummary(report);
  }

  private getLocationSummary(report: Report) {
    return {
      id: report.id,
      latitude: report.latitude,
      longitude: report.longitude,
      accuracyMeters: report.locationAccuracyMeters,
      verified: report.locationVerified,
      verifiedAt: report.locationVerifiedAt,
      note: report.locationNote,
    };
  }

  // bbox = "minLng,minLat,maxLng,maxLat"
  private parseBbox(bbox?: string) {
    if (!bbox) return null;
    const p = bbox.split(',').map((v) => Number(v.trim()));
    if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) {
      throw new BadRequestException('invalid_bbox');
    }
    const [minLng, minLat, maxLng, maxLat] = p;
    if (minLat > maxLat || minLng > maxLng) throw new BadRequestException('invalid_bbox');
    return { minLng, minLat, maxLng, maxLat };
  }

  // GP-05 GET /reports/map   (clustered pins)
  async getMapPins(admin: CurrentUserDto, query: ReportMapQueryDto) {
    const box = this.parseBbox(query.bbox);
    const zoom = query.zoom ?? 8;
    const cap = Number(this.configService.get<string>('REPORT_MAP_MAX_POINTS') ?? 5000);

    const where: Prisma.ReportWhereInput = {
      AND: [
        this.reportCommonService.statsWhere(query, admin),
        { latitude: { not: null }, longitude: { not: null } },
        box
          ? {
              latitude: { gte: box.minLat, lte: box.maxLat },
              longitude: { gte: box.minLng, lte: box.maxLng },
            }
          : {},
      ],
    };

    const rows = await this.prisma.report.findMany({
      where,
      select: {
        id: true,
        caseReference: true,
        latitude: true,
        longitude: true,
        status: true,
        category: true,
        priority: true,
      },
      orderBy: { createdAt: 'desc' },
      take: cap,
    });

    // Grid clustering: cell size halves each zoom level; no clustering from zoom 15
    const cell = zoom >= 15 ? 0 : 360 / Math.pow(2, zoom + 2);
    if (cell === 0) {
      return {
        zoom,
        truncated: rows.length === cap,
        pins: rows.map((r) => ({
          type: 'report' as const,
          id: r.id,
          caseReference: r.caseReference,
          latitude: r.latitude!,
          longitude: r.longitude!,
          status: r.status,
          category: r.category,
          priority: r.priority,
        })),
      };
    }

    const cells = new Map<string, { lat: number; lng: number; ids: string[] }>();
    for (const r of rows) {
      const key = `${Math.floor(r.latitude! / cell)}:${Math.floor(r.longitude! / cell)}`;
      const c = cells.get(key) ?? { lat: 0, lng: 0, ids: [] };
      c.lat += r.latitude!;
      c.lng += r.longitude!;
      c.ids.push(r.id);
      cells.set(key, c);
    }

    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      zoom,
      truncated: rows.length === cap,
      pins: [...cells.values()].map((c) =>
        c.ids.length === 1
          ? {
              type: 'report' as const,
              id: c.ids[0],
              caseReference: byId.get(c.ids[0])!.caseReference,
              latitude: c.lat,
              longitude: c.lng,
              status: byId.get(c.ids[0])!.status,
              category: byId.get(c.ids[0])!.category,
              priority: byId.get(c.ids[0])!.priority,
            }
          : {
              type: 'cluster' as const,
              count: c.ids.length,
              latitude: c.lat / c.ids.length,
              longitude: c.lng / c.ids.length,
            },
      ),
    };
  }

  private haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
  }

  // GP-06 GET /reports/nearby
  async findNearby(admin: CurrentUserDto, query: NearbyReportsQueryDto) {
    const radiusKm = query.radiusKm ?? 5;
    const dLat = radiusKm / 111;
    const dLng = radiusKm / (111 * Math.max(0.01, Math.cos((query.lat * Math.PI) / 180)));

    const candidates = await this.prisma.report.findMany({
      where: {
        AND: [
          { deletedAt: null },
          this.reportCommonService.visibilityWhere(admin),
          {
            latitude: { gte: query.lat - dLat, lte: query.lat + dLat },
            longitude: { gte: query.lng - dLng, lte: query.lng + dLng },
            ...(query.status ? { status: query.status } : {}),
            ...(query.category ? { category: query.category } : {}),
          },
        ],
      },
      select: {
        id: true,
        caseReference: true,
        latitude: true,
        longitude: true,
        status: true,
        category: true,
        priority: true,
        createdAt: true,
      },
      take: 2000,
    });

    const within = candidates
      .map((r) => ({
        ...r,
        distanceKm:
          Math.round(this.haversineKm(query.lat, query.lng, r.latitude!, r.longitude!) * 100) / 100,
      }))
      .filter((r) => r.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);

    const { page, limit, skip } = this.reportCommonService.paging(query);
    return { items: within.slice(skip, skip + limit), total: within.length, page, limit, radiusKm };
  }

  // GP-07 GET /reports/hotspots   (grid heatmap)
  async getHotspots(admin: CurrentUserDto, query: HotspotsQueryDto) {
    const gridKm = query.gridKm ?? 2;
    const latStep = gridKm / 111;
    const where = this.reportCommonService.statsFilterSql(query, admin);

    const rows = await this.prisma.$queryRaw<
      Array<{ gy: number; gx: number; count: number; lat: number; lng: number }>
    >`
      SELECT FLOOR(r.latitude / ${latStep})::int AS gy,
             FLOOR(r.longitude / (${latStep} / GREATEST(0.01, COS(RADIANS(r.latitude)))))::int AS gx,
             COUNT(*)::int AS count,
             AVG(r.latitude)::float AS lat,
             AVG(r.longitude)::float AS lng
      FROM ${REPORT_TABLE} r
      WHERE ${where} AND r.latitude IS NOT NULL AND r.longitude IS NOT NULL
      GROUP BY 1, 2
      ORDER BY count DESC
      LIMIT 500
    `;

    const max = rows[0]?.count ?? 0;
    return {
      gridKm,
      cells: rows.map((r) => ({
        latitude: r.lat,
        longitude: r.lng,
        count: r.count,
        intensity: max ? Math.round((r.count / max) * 100) / 100 : 0,
      })),
    };
  }
}
