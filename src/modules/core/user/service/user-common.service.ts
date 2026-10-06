import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditOutcome, AuditSeverity, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { normalizePhoneNumber } from 'src/common/utils/phone.util';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { PermissionsEnum } from 'src/common/enums/permissions.enum';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';
import { StatsInterval, UsersPagedQueryDto, UserStatsQueryDto } from '../dto/user.dto';
import {
  LINKED_PROVIDERS,
  VIEW_ENTITY,
  USER_CONTENT_SOURCES,
  EMPTY_PROFILE_FIELDS,
  FULL_PROFILE_SELECT,
} from './user.constants';

@Injectable()
export class UserCommonService {
  private readonly logger = new Logger(UserCommonService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  getRoles(user: CurrentUserDto): string[] {
    return (user as unknown as { roles?: string[] }).roles ?? [];
  }

  buildUserLabel(user: {
    name?: string | null;
    phone?: string | null;
    email?: string | null;
  }): string | undefined {
    return user.name ?? user.phone ?? user.email ?? undefined;
  }

  // Last-4-digits mask, same convention as AuthService.maskPhone.
  maskPhone(phone: string | null | undefined): string {
    if (!phone) return '****';
    return phone.length <= 4 ? '****' : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
  }

  normalizePhoneOrThrow(phone: string): string {
    try {
      return normalizePhoneNumber(phone);
    } catch {
      throw new BadRequestException('invalid_phone_number');
    }
  }

  isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  isSuperAdmin(roleNames: string[]): boolean {
    return roleNames.includes(RolesEnum.SUPER_ADMIN);
  }

  shapeProfile<
    T extends {
      userRoles: { role: { id: string; name: string } }[];
      profile?: Record<string, unknown> | null;
    },
  >(user: T) {
    const roles = user.userRoles.map((userRole) => userRole.role);
    const { userRoles: _userRoles, profile, ...userData } = user;
    if (profile === undefined) {
      return { ...userData, roles };
    }
    return { ...userData, ...(profile ?? EMPTY_PROFILE_FIELDS), roles };
  }

  // ── GET CURRENT USER / GET USER BY ID (ADMIN) ──

  async getMe(currentUser: CurrentUserDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: currentUser.id },
      select: FULL_PROFILE_SELECT,
    });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    return this.shapeProfile(user);
  }

  // No view-audit here — also called internally by deactivate/reactivate/
  // unlock/assignRole/revokeRole, which would double-log every write.
  async getUserById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: FULL_PROFILE_SELECT,
    });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    return this.shapeProfile(user);
  }

  async listSessions(userId: string) {
    return this.prisma.session.findMany({
      where: { userId, revokedAt: null },
      select: { id: true, createdAt: true, expiresAt: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // Untyped client for the assumed models/fields above; swap to this.prisma once the schema matches.
  get db(): any {
    return this.prisma as any;
  }

  paging(q: { page?: number; limit?: number }) {
    const page = q.page && q.page > 0 ? q.page : 1;
    const limit = q.limit && q.limit > 0 ? Math.min(q.limit, 100) : 20;
    return { page, limit, skip: (page - 1) * limit };
  }

  pageMeta(page: number, limit: number, total: number) {
    return { page, limit, total, totalPages: Math.ceil(total / limit) };
  }

  maskEmail(email: string | null | undefined): string | null {
    if (!email) return null;
    const [local, domain] = email.split('@');
    return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
  }

  // Without USER_PII_READ the actor only ever sees masked contact details.
  canSeePii(actor: CurrentUserDto): boolean {
    const permissions = (actor as unknown as { permissions?: string[] }).permissions ?? [];
    return permissions.includes(PermissionsEnum.USER_PII_READ);
  }

  maskUser<T extends { phone?: string | null; email?: string | null }>(
    actor: CurrentUserDto,
    user: T,
  ): T {
    if (this.canSeePii(actor)) return user;
    return { ...user, phone: this.maskPhone(user.phone), email: this.maskEmail(user.email) };
  }

  shapeListed(actor: CurrentUserDto, user: any) {
    const { userRoles, ...rest } = user;
    const roles = (userRoles ?? []).map((ur: { role: unknown }) => ur.role);
    return this.maskUser(actor, { ...rest, roles });
  }

  async requireUser(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, phone: true, email: true, isActive: true },
    });
    if (!user) {
      throw new NotFoundException('user_not_found');
    }
    return user;
  }

  // Single audit entry for the new methods; targetUserId only set when actor != target.
  auditUser(
    actor: CurrentUserDto,
    targetUserId: string,
    action: AuditEventEnum,
    context: string,
    opts: {
      reason?: string | null;
      severity?: AuditSeverity;
      outcome?: AuditOutcome;
      label?: string;
      diff?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    } = {},
  ): void {
    this.emitAudit({
      userId: actor.id,
      ...(actor.id === targetUserId ? {} : { targetUserId }),
      actorType: resolveActorType(this.getRoles(actor)),
      action,
      ...(opts.outcome && { outcome: opts.outcome }),
      ...(opts.severity && { severity: opts.severity }),
      entity: 'User',
      entityId: targetUserId,
      entityLabel: opts.label,
      reason: opts.reason ?? null,
      diff: { result: 'success', context, ...opts.diff },
      metadata: opts.metadata,
    });
  }

  // Admin reads of a user's record are logged under their own entity so getHistory() stays clean.
  recordView(actor: CurrentUserDto, targetUserId: string, section: string): void {
    if (actor.id === targetUserId) return;
    this.emitAudit({
      userId: actor.id,
      targetUserId,
      actorType: resolveActorType(this.getRoles(actor)),
      action: AuditEventEnum.USER_UPDATED,
      entity: VIEW_ENTITY,
      entityId: targetUserId,
      diff: { result: 'success', context: 'record_viewed' },
      metadata: { section },
    });
  }

  async countFor(model: string, where: Record<string, unknown>): Promise<number> {
    try {
      return await this.db[model].count({ where });
    } catch (err) {
      this.logger.warn(`count on "${model}" failed: ${err instanceof Error ? err.message : err}`);
      return 0;
    }
  }

  async listFor(model: string, args: Record<string, unknown>): Promise<any[]> {
    try {
      return await this.db[model].findMany(args);
    } catch (err) {
      this.logger.warn(
        `findMany on "${model}" failed: ${err instanceof Error ? err.message : err}`,
      );
      return [];
    }
  }

  // Social logins are columns on User (googleId, facebookId, appleId), not a separate table.
  async linkedProviders(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { googleId: true, facebookId: true, appleId: true, passwordHash: true },
    });
    const providers = LINKED_PROVIDERS.filter((p) => !!(user as any)?.[`${p}Id`]);
    return { providers, hasPassword: !!user?.passwordHash };
  }

  async buildSummary(userId: string): Promise<Record<string, number>> {
    const entries = await Promise.all(
      Object.entries(USER_CONTENT_SOURCES).map(
        async ([key, [model, field]]) =>
          [key, await this.countFor(model, { [field]: userId })] as const,
      ),
    );
    return Object.fromEntries(entries);
  }

  // Runtime lookup keeps this working whatever the audit enum calls its login/security events.
  eventsMatching(pattern: RegExp): AuditEventEnum[] {
    return Object.values(AuditEventEnum).filter((v) => pattern.test(String(v))) as AuditEventEnum[];
  }

  coarseIp(ip: string | null | undefined): string | null {
    if (!ip) return null;
    if (ip.includes(':')) return `${ip.split(':').slice(0, 3).join(':')}::`;
    return `${ip.split('.').slice(0, 2).join('.')}.x.x`;
  }

  shapeEvent(row: any) {
    return {
      id: row.id,
      event: row.action,
      outcome: row.outcome,
      at: row.createdAt,
      device: row.userAgent ?? null,
      location: this.coarseIp(row.ipAddress),
    };
  }

  async auditPage(
    where: Prisma.AuditLogWhereInput,
    query: { page?: number; limit?: number },
    mapRow?: (row: any) => unknown,
  ) {
    const { page, limit, skip } = this.paging(query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take: limit }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { data: mapRow ? rows.map(mapRow) : rows, meta: this.pageMeta(page, limit, total) };
  }

  rangeOf(q: UserStatsQueryDto, defaultDays: number) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - defaultDays * 86_400_000);
    return { from, to };
  }

  statsWhere(q: UserStatsQueryDto): Prisma.UserWhereInput {
    const where: Prisma.UserWhereInput = {};
    if (q.from || q.to) {
      where.createdAt = {
        ...(q.from && { gte: new Date(q.from) }),
        ...(q.to && { lte: new Date(q.to) }),
      };
    }
    if (q.role) where.userRoles = { some: { role: { name: q.role } } };
    if (q.region) where.profile = { is: { region: q.region } };
    if (q.status === 'active') where.isActive = true;
    else if (q.status === 'inactive') where.isActive = false;
    else if (q.status === 'locked') where.lockedUntil = { gt: new Date() };
    return where;
  }

  searchWhere(text: string | undefined, q: UserStatsQueryDto): Prisma.UserWhereInput {
    const base = this.statsWhere(q);
    const term = text?.trim();
    if (!term) return base;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(term);
    const or: Prisma.UserWhereInput[] = [
      { name: { contains: term, mode: 'insensitive' } },
      { phone: { contains: term } },
    ];
    if (isUuid) or.push({ id: term });
    return { AND: [base, { OR: or }] };
  }

  bucketKey(date: Date, interval: StatsInterval): string {
    if (interval === StatsInterval.MONTH) return date.toISOString().slice(0, 7);
    if (interval === StatsInterval.WEEK) {
      const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
      day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
      return day.toISOString().slice(0, 10);
    }
    return date.toISOString().slice(0, 10);
  }

  bucketDates(dates: Date[], interval: StatsInterval = StatsInterval.DAY) {
    const counts = new Map<string, number>();
    for (const d of dates) {
      const key = this.bucketKey(d, interval);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));
  }

  activeRestrictionWhere() {
    return { liftedAt: null, OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] };
  }

  async loginHistory(userId: string, query: UsersPagedQueryDto) {
    const { page, limit, skip } = this.paging(query);
    const where = { userId };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.loginAttempt.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.loginAttempt.count({ where }),
    ]);
    // Never return ipAddress or the raw userAgent (discreet mode); device label and city/country only.
    return {
      data: rows.map((r) => ({
        id: r.id,
        result: r.result,
        failureReason: r.failureReason,
        at: r.createdAt,
        device: r.deviceLabel,
        location: [r.city, r.country].filter(Boolean).join(', ') || null,
      })),
      meta: this.pageMeta(page, limit, total),
    };
  }

  securityEvents(userId: string, query: UsersPagedQueryDto) {
    return this.auditPage(
      {
        OR: [{ userId }, { targetUserId: userId }],
        action: { in: this.eventsMatching(/password|phone|lock|fail|security|otp|session/i) },
      },
      query,
      (row) => this.shapeEvent(row),
    );
  }

  async getUserVerification(actor: CurrentUserDto, userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        phone: true,
        pendingPhone: true,
        isPhoneVerified: true,
        isEmailVerified: true,
        email: true,
      },
    });
    if (!user) throw new NotFoundException('user_not_found');
    this.recordView(actor, userId, 'verification');
    return {
      phone: {
        masked: this.maskPhone(user.phone),
        verified: !!user.isPhoneVerified,
        changePending: !!user.pendingPhone,
      },
      email: { present: !!user.email, verified: !!user.isEmailVerified },
    };
  }
}
