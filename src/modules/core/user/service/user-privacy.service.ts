import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditSeverity } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { DeletionRequestStatus, RequestAccountDeletionDto } from '../dto/user.dto';
import { UserCommonService } from './user-common.service';
import { DELETION_GRACE_DAYS, OPEN_DELETION_STATUSES, VIEW_ENTITY } from './user.constants';

@Injectable()
export class UserPrivacyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userCommonService: UserCommonService,
  ) {}

  async getMyDataExport(currentUser: CurrentUserDto) {
    const userId = currentUser.id;
    const user = await this.userCommonService.getMe(currentUser);
    const [sessions, activity, consents, linkedAccounts, deletionRequests, notifications, summary] =
      await Promise.all([
        this.userCommonService.listSessions(userId),
        this.prisma.auditLog.findMany({
          where: { OR: [{ userId }, { targetUserId: userId }], entity: { not: VIEW_ENTITY } },
          select: { id: true, action: true, outcome: true, createdAt: true },
          orderBy: { createdAt: 'desc' },
          take: 5000,
        }),
        this.userCommonService.listFor('userConsent', { where: { userId }, orderBy: { createdAt: 'desc' } }),
        this.userCommonService.linkedProviders(userId).then((r) => r.providers),
        this.userCommonService.listFor('userDeletionRequest', { where: { userId }, orderBy: { createdAt: 'desc' } }),
        this.userCommonService.listFor('notification', {
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 1000,
        }),
        this.userCommonService.buildSummary(userId),
      ]);

    this.userCommonService.auditUser(currentUser, userId, AuditEventEnum.USER_UPDATED, 'data_export');

    return {
      exportedAt: new Date().toISOString(),
      user,
      summary,
      sessions,
      activity,
      consents,
      linkedAccounts,
      deletionRequests,
      notifications,
    };
  }

  async requestMyDeletion(currentUser: CurrentUserDto, data: RequestAccountDeletionDto) {
    const user = await this.userCommonService.db.user.findUnique({
      where: { id: currentUser.id },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        legalHold: true,
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!user) throw new NotFoundException('user_not_found');
    if (user.legalHold) throw new ForbiddenException('account_on_legal_hold');

    const roleNames: string[] = user.userRoles.map((ur: any) => ur.role.name);
    if (this.userCommonService.isSuperAdmin(roleNames)) {
      const others = await this.prisma.user.count({
        where: {
          id: { not: user.id },
          isActive: true,
          userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
        },
      });
      if (others === 0) throw new ForbiddenException('cannot_delete_last_super_admin');
    }

    const open = await this.userCommonService.db.userDeletionRequest.findFirst({
      where: { userId: user.id, status: { in: OPEN_DELETION_STATUSES } },
    });
    if (open) throw new BadRequestException('deletion_already_requested');

    const scheduledFor = new Date(Date.now() + DELETION_GRACE_DAYS * 86_400_000);
    const request = await this.userCommonService.db.userDeletionRequest.create({
      data: {
        userId: user.id,
        reason: data.reason?.trim() || null,
        status: DeletionRequestStatus.PENDING,
        scheduledFor,
      },
    });

    this.userCommonService.auditUser(currentUser, user.id, AuditEventEnum.USER_UPDATED, 'deletion_requested', {
      severity: AuditSeverity.WARNING,
      label: this.userCommonService.buildUserLabel(user),
      diff: { requestId: request.id, scheduledFor },
    });

    return { message: 'deletion_requested', requestId: request.id, scheduledFor };
  }

  async cancelMyDeletionRequest(currentUser: CurrentUserDto): Promise<{ message: string }> {
    const result = await this.userCommonService.db.userDeletionRequest.updateMany({
      where: { userId: currentUser.id, status: { in: OPEN_DELETION_STATUSES } },
      data: { status: DeletionRequestStatus.CANCELLED },
    });
    if (result.count === 0) throw new NotFoundException('no_open_deletion_request');

    this.userCommonService.auditUser(currentUser, currentUser.id, AuditEventEnum.USER_UPDATED, 'deletion_cancelled');
    return { message: 'deletion_request_cancelled' };
  }

  async getMyDeletionRequest(currentUser: CurrentUserDto) {
    const request = await this.userCommonService.db.userDeletionRequest.findFirst({
      where: { userId: currentUser.id },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, reason: true, scheduledFor: true, createdAt: true },
    });
    return { request: request ?? null };
  }
}
