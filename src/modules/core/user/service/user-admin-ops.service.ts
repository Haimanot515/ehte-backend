import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { AuditOutcome, AuditSeverity, OtpChannelEnum, UserOtpPurposeEnum } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { OtpUtil } from 'src/common/utils/otp.util';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import {
  AdminActionReasonDto,
  AdminChangePhoneDto,
  AdminRequiredReasonDto,
  DecideDeletionRequestDto,
  DeletionDecision,
  DeletionRequestStatus,
  LegalHoldDto,
  MergeUserDto,
} from '../dto/user.dto';
import { UserCommonService } from './user-common.service';
import {
  DELETION_GRACE_DAYS,
  OPEN_DELETION_STATUSES,
  USER_CONTENT_SOURCES,
} from './user.constants';

@Injectable()
export class UserAdminOpsService {
  private readonly logger = new Logger(UserAdminOpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly otpUtil: OtpUtil,
    private readonly minioService: MinioService,
    private readonly cache: CacheService,
    private readonly userCommonService: UserCommonService,
  ) {}

  private async purgeRelated(models: string[], userId: string): Promise<void> {
    for (const model of models) {
      try {
        await this.userCommonService.db[model].deleteMany({ where: { userId } });
      } catch (err) {
        this.logger.warn(`purge on "${model}" failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  async decideDeleteRequest(
    actor: CurrentUserDto,
    requestId: string,
    data: DecideDeletionRequestDto,
  ) {
    const request = await this.userCommonService.db.userDeletionRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new NotFoundException('deletion_request_not_found');
    if (!OPEN_DELETION_STATUSES.includes(request.status)) {
      throw new BadRequestException('request_already_decided');
    }

    const target = await this.userCommonService.db.user.findUnique({
      where: { id: request.userId },
      select: { id: true, name: true, phone: true, email: true, legalHold: true },
    });
    if (data.decision === DeletionDecision.APPROVE && target?.legalHold) {
      throw new ForbiddenException('account_on_legal_hold');
    }

    const patch: Record<string, unknown> = {};
    if (data.decision === DeletionDecision.APPROVE) patch.status = DeletionRequestStatus.APPROVED;
    else if (data.decision === DeletionDecision.DECLINE)
      patch.status = DeletionRequestStatus.DECLINED;
    else {
      const until = data.delayUntil ? new Date(data.delayUntil) : null;
      if (!until || until.getTime() <= Date.now()) {
        throw new BadRequestException('delay_until_must_be_in_future');
      }
      patch.status = DeletionRequestStatus.DELAYED;
      patch.scheduledFor = until;
    }

    const updated = await this.userCommonService.db.userDeletionRequest.update({
      where: { id: requestId },
      data: { ...patch, decidedById: actor.id, decidedAt: new Date(), decisionReason: data.reason },
    });

    this.userCommonService.auditUser(
      actor,
      request.userId,
      AuditEventEnum.USER_UPDATED,
      'deletion_decision',
      {
        severity: AuditSeverity.WARNING,
        reason: data.reason,
        label: target ? this.userCommonService.buildUserLabel(target) : undefined,
        diff: { requestId, decision: data.decision, status: updated.status },
      },
    );
    return updated;
  }

  async getErasurePreview(actor: CurrentUserDto, userId: string) {
    const target = await this.userCommonService.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        isActive: true,
        legalHold: true,
        anonymizedAt: true,
        profile: { select: { profilePictureUrl: true } },
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!target) throw new NotFoundException('user_not_found');
    this.userCommonService.recordView(actor, userId, 'erasure_preview');

    const roleNames: string[] = target.userRoles.map((ur: any) => ur.role.name);
    const otherSuperAdmins = this.userCommonService.isSuperAdmin(roleNames)
      ? await this.prisma.user.count({
          where: {
            id: { not: userId },
            isActive: true,
            userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
          },
        })
      : null;

    const [sessions, linkedAccounts, devices, auditEntries, content] = await Promise.all([
      this.prisma.session.count({ where: { userId } }),
      this.userCommonService.linkedProviders(userId).then((r) => r.providers.length),
      this.userCommonService.countFor('deviceToken', { userId }),
      this.prisma.auditLog.count({ where: { OR: [{ userId }, { targetUserId: userId }] } }),
      this.userCommonService.buildSummary(userId),
    ]);

    const blockers = [
      ...(target.legalHold ? ['account_on_legal_hold'] : []),
      ...(target.anonymizedAt ? ['already_anonymized'] : []),
      ...(otherSuperAdmins === 0 ? ['last_super_admin'] : []),
      ...(actor.id === userId ? ['cannot_target_self'] : []),
    ];
    return {
      userId,
      canProceed: blockers.length === 0,
      blockers,
      willRemove: {
        name: true,
        phone: true,
        email: true,
        profile: true,
        profilePicture: !!target.profile?.profilePictureUrl,
        sessions,
        linkedAccounts,
        devices,
      },
      willKeep: { auditEntries, content },
    };
  }

  async anonymizeUser(actor: CurrentUserDto, userId: string, data: AdminRequiredReasonDto) {
    if (actor.id === userId) throw new BadRequestException('cannot_anonymize_self');
    const target = await this.userCommonService.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        isActive: true,
        legalHold: true,
        anonymizedAt: true,
        profile: { select: { profilePictureUrl: true } },
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!target) throw new NotFoundException('user_not_found');
    const label = this.userCommonService.buildUserLabel(target);

    if (target.legalHold) {
      this.userCommonService.auditUser(
        actor,
        userId,
        AuditEventEnum.USER_UPDATED,
        'anonymize_denied',
        {
          outcome: AuditOutcome.DENIED,
          severity: AuditSeverity.CRITICAL,
          reason: data.reason,
          label,
          diff: { result: 'denied', reason: 'account_on_legal_hold' },
        },
      );
      throw new ForbiddenException('account_on_legal_hold');
    }
    if (target.anonymizedAt) throw new BadRequestException('already_anonymized');

    const roleNames: string[] = target.userRoles.map((ur: any) => ur.role.name);
    if (this.userCommonService.isSuperAdmin(roleNames) && target.isActive) {
      const others = await this.prisma.user.count({
        where: {
          id: { not: userId },
          isActive: true,
          userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
        },
      });
      if (others === 0) throw new ForbiddenException('cannot_anonymize_last_super_admin');
    }

    const passwordHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
    const previousPicture: string | null = target.profile?.profilePictureUrl ?? null;

    await this.prisma.$transaction(async (tx) => {
      await (tx as any).user.update({
        where: { id: userId },
        data: {
          name: 'Deleted user',
          // Placeholder keeps the unique phone column valid without leaking the number.
          phone: `anon-${userId}`,
          email: null,
          pendingPhone: null,
          passwordHash,
          isActive: false,
          discreetModeEnabled: false,
          discreetModePasscodeHash: null,
          googleId: null,
          facebookId: null,
          appleId: null,
          anonymizedAt: new Date(),
        },
      });
      await tx.userProfile.deleteMany({ where: { userId } });
      await tx.session.deleteMany({ where: { userId } });
    });

    await this.purgeRelated(['deviceToken'], userId);
    if (previousPicture) await this.minioService.deleteFile(previousPicture).catch(() => undefined);
    await this.cache.purgeUserCache(userId);

    this.userCommonService.auditUser(actor, userId, AuditEventEnum.USER_UPDATED, 'anonymized', {
      severity: AuditSeverity.CRITICAL,
      reason: data.reason,
      label,
    });
    return { message: 'user_anonymized' };
  }

  async setUserLegalHold(actor: CurrentUserDto, userId: string, data: LegalHoldDto) {
    const target = await this.userCommonService.db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true, email: true, legalHold: true },
    });
    if (!target) throw new NotFoundException('user_not_found');
    if (!!target.legalHold === data.legalHold) {
      throw new BadRequestException(
        data.legalHold ? 'legal_hold_already_set' : 'no_legal_hold_to_lift',
      );
    }

    await this.userCommonService.db.user.update({
      where: { id: userId },
      data: { legalHold: data.legalHold },
    });

    this.userCommonService.auditUser(
      actor,
      userId,
      AuditEventEnum.USER_UPDATED,
      data.legalHold ? 'legal_hold_set' : 'legal_hold_lifted',
      {
        severity: AuditSeverity.WARNING,
        reason: data.reason,
        label: this.userCommonService.buildUserLabel(target),
        diff: { previousLegalHold: !!target.legalHold, currentLegalHold: data.legalHold },
      },
    );
    return { userId, legalHold: data.legalHold };
  }

  async restoreDeletedUser(actor: CurrentUserDto, userId: string, data: AdminActionReasonDto) {
    const target = await this.userCommonService.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        deletedAt: true,
        anonymizedAt: true,
      },
    });
    if (!target) throw new NotFoundException('user_not_found');
    if (target.anonymizedAt) throw new BadRequestException('account_already_erased');

    const approved = await this.userCommonService.db.userDeletionRequest.findFirst({
      where: { userId, status: DeletionRequestStatus.APPROVED },
    });
    if (!target.deletedAt && !approved) throw new BadRequestException('user_not_pending_deletion');
    if (
      target.deletedAt &&
      Date.now() > target.deletedAt.getTime() + DELETION_GRACE_DAYS * 86_400_000
    ) {
      throw new BadRequestException('grace_period_over');
    }

    await this.userCommonService.db.user.update({
      where: { id: userId },
      data: { deletedAt: null, isActive: true },
    });
    await this.userCommonService.db.userDeletionRequest.updateMany({
      where: {
        userId,
        status: { in: [DeletionRequestStatus.APPROVED, ...OPEN_DELETION_STATUSES] },
      },
      data: { status: DeletionRequestStatus.CANCELLED },
    });
    await this.cache.purgeUserCache(userId);

    this.userCommonService.auditUser(
      actor,
      userId,
      AuditEventEnum.USER_REACTIVATED,
      'deleted_user_restored',
      {
        severity: AuditSeverity.WARNING,
        reason: data.reason,
        label: this.userCommonService.buildUserLabel(target),
      },
    );
    return this.userCommonService.getUserById(userId);
  }

  async mergeUser(actor: CurrentUserDto, primaryId: string, data: MergeUserDto) {
    const duplicateId = data.duplicateUserId;
    if (duplicateId === primaryId) throw new BadRequestException('cannot_merge_into_self');

    const select = {
      id: true,
      name: true,
      phone: true,
      email: true,
      legalHold: true,
      userRoles: { select: { role: { select: { name: true } } } },
    };
    const [primary, duplicate] = await Promise.all([
      this.userCommonService.db.user.findUnique({ where: { id: primaryId }, select }),
      this.userCommonService.db.user.findUnique({ where: { id: duplicateId }, select }),
    ]);
    if (!primary || !duplicate) throw new NotFoundException('user_not_found');
    if (duplicate.legalHold) throw new ForbiddenException('duplicate_on_legal_hold');

    const privileged = [primary, duplicate].some((u) =>
      u.userRoles.some((ur: any) =>
        ([RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] as string[]).includes(ur.role.name),
      ),
    );
    if (privileged) throw new ForbiddenException('cannot_merge_admin_accounts');

    // One transaction: if any move fails, nothing is merged.
    const moves = Object.values(USER_CONTENT_SOURCES).filter(
      ([model]) => !!this.userCommonService.db[model],
    );
    const moved: Record<string, number> = {};
    await this.prisma.$transaction(async (tx) => {
      const t = tx as any;
      for (const [model, field] of moves) {
        const result = await t[model].updateMany({
          where: { [field]: duplicateId },
          data: { [field]: primaryId },
        });
        moved[model] = result.count;
      }
      await tx.session.deleteMany({ where: { userId: duplicateId } });
      await t.user.update({ where: { id: duplicateId }, data: { isActive: false } });
    });

    await Promise.all([
      this.cache.purgeUserCache(primaryId),
      this.cache.purgeUserCache(duplicateId),
    ]);

    this.userCommonService.auditUser(actor, primaryId, AuditEventEnum.USER_UPDATED, 'user_merged', {
      severity: AuditSeverity.CRITICAL,
      reason: data.reason,
      label: this.userCommonService.buildUserLabel(primary),
      diff: { duplicateUserId: duplicateId, moved },
    });
    return this.userCommonService.getUserById(primaryId);
  }

  async markPhoneVerified(actor: CurrentUserDto, userId: string, data: AdminRequiredReasonDto) {
    const target = await this.userCommonService.db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, phone: true, email: true, isPhoneVerified: true },
    });
    if (!target) throw new NotFoundException('user_not_found');
    if (target.isPhoneVerified) throw new BadRequestException('phone_already_verified');

    await this.userCommonService.db.user.update({
      where: { id: userId },
      data: { isPhoneVerified: true },
    });
    await this.cache.purgeUserCache(userId);

    this.userCommonService.auditUser(
      actor,
      userId,
      AuditEventEnum.USER_UPDATED,
      'phone_marked_verified',
      {
        severity: AuditSeverity.WARNING,
        reason: data.reason,
        label: this.userCommonService.buildUserLabel(target),
        diff: { previousVerified: false, currentVerified: true },
      },
    );
    return this.userCommonService.getUserVerification(actor, userId);
  }

  // The code goes to the new number; the user then completes it with POST /users/me/change-phone/verify.
  async adminChangePhone(actor: CurrentUserDto, userId: string, data: AdminChangePhoneDto) {
    const newPhone = this.userCommonService.normalizePhoneOrThrow(data.newPhone);
    const target = await this.userCommonService.requireUser(userId);
    if (target.phone === newPhone) throw new BadRequestException('phone_unchanged');

    const inUse = await this.prisma.user.findUnique({ where: { phone: newPhone } });
    if (inUse && inUse.id !== userId) throw new BadRequestException('phone_already_registered');

    try {
      await this.prisma.user.update({ where: { id: userId }, data: { pendingPhone: newPhone } });
    } catch (error) {
      if (this.userCommonService.isUniqueConstraintError(error))
        throw new BadRequestException('phone_already_registered');
      throw error;
    }
    const { verificationId } = await this.otpUtil.issueAndSendOtp(
      userId,
      newPhone,
      UserOtpPurposeEnum.phone_change,
      OtpChannelEnum.sms,
    );

    this.userCommonService.auditUser(
      actor,
      userId,
      AuditEventEnum.USER_UPDATED,
      'admin_change_phone_initiated',
      {
        severity: AuditSeverity.WARNING,
        reason: data.reason,
        label: this.userCommonService.buildUserLabel(target),
        diff: {
          previousPhoneMasked: this.userCommonService.maskPhone(target.phone),
          newPhoneMasked: this.userCommonService.maskPhone(newPhone),
        },
      },
    );
    this.eventEmitter.emit(NotificationEventEnum.SECURITY_ALERT, {
      userId,
      reason: 'phone_change_requested_by_admin',
    });
    return { message: 'otp_sent_to_new_phone', verificationId };
  }
}
