#!/usr/bin/env python3
"""
apply-audit-fixes-2.py: wires the remaining audit events. Run AFTER apply-audit-fixes.py.

    python3 apply-audit-fixes-2.py src --dry-run
    python3 apply-audit-fixes-2.py src
Safe to run twice.
"""
import os, re, sys

ROOT = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else 'src'
DRY = '--dry-run' in sys.argv
OK, SKIP, FAIL = [], [], []
ENUM_MOD = 'src/common/enums/shared/audit-events.enum'

def path(p): return os.path.join(ROOT, p)
def read(p):
    with open(path(p), encoding='utf-8') as f: return f.read()
def write(p, s):
    if not DRY:
        with open(path(p), 'w', encoding='utf-8') as f: f.write(s)

def has_import_name(src, name):
    return re.search(r'import[^;]*\b' + re.escape(name) + r'\b[^;]*from', src) is not None

def last_import_end(src):
    end = 0
    for m in re.finditer(r'^import[^;]*;[ \t]*\n', src, re.M): end = m.end()
    return end

def add_named_import(src, name, module):
    if has_import_name(src, name): return src
    m = re.search(r"(import\s*\{)([^}]*)(\}\s*from\s*'" + re.escape(module) + r"';)", src)
    if m:
        inner = m.group(2).rstrip()
        sep = '' if inner.endswith(',') or inner.strip() == '' else ','
        if '\n' in m.group(2): new = m.group(1) + inner + sep + '\n  ' + name + ',\n' + m.group(3)
        else: new = m.group(1) + inner.rstrip() + sep + ' ' + name + ' ' + m.group(3)
        return src[:m.start()] + new + src[m.end():]
    i = last_import_end(src)
    return src[:i] + "import { %s } from '%s';\n" % (name, module) + src[i:]

def replace_once(label, rel, old, new, imports=()):
    try: s = read(rel)
    except FileNotFoundError: FAIL.append((label, rel + ' not found')); return
    if new in s: SKIP.append((label, 'already applied')); return
    if s.count(old) != 1:
        FAIL.append((label, '%s: anchor matched %d times (expected 1); apply by hand' % (rel, s.count(old)))); return
    s = s.replace(old, new)
    for name, mod in imports: s = add_named_import(s, name, mod)
    write(rel, s); OK.append((label, rel))

AT = ('ActorType', '@prisma/client')
AE = ('AuditEventEnum', ENUM_MOD)

# 1. missing-person: more operation names -> specific actions
replace_once('missing-person: legal hold / child flag / renew / media removed / found verified',
 'modules/core/missing-person/service/missing-person-common.service.ts',
"""  export_job_download: AuditEventEnum.MISSING_PERSON_EXPORT_DOWNLOADED,
};""",
"""  export_job_download: AuditEventEnum.MISSING_PERSON_EXPORT_DOWNLOADED,
  legal_hold_placed: AuditEventEnum.MISSING_PERSON_LEGAL_HOLD_CHANGED,
  legal_hold_released: AuditEventEnum.MISSING_PERSON_LEGAL_HOLD_CHANGED,
  child_flag_corrected: AuditEventEnum.MISSING_PERSON_CHILD_FLAG_CORRECTED,
  admin_renew: AuditEventEnum.MISSING_PERSON_RENEWED,
  owner_renew: AuditEventEnum.MISSING_PERSON_RENEWED,
  admin_remove_media: AuditEventEnum.MISSING_PERSON_MEDIA_REMOVED,
  owner_remove_media: AuditEventEnum.MISSING_PERSON_MEDIA_REMOVED,
  found_report_confirmed: AuditEventEnum.MISSING_PERSON_FOUND_REPORT_VERIFIED,
};""")

# 2. missing-person export job expiry (happens on read)
replace_once('missing-person export expiry',
 'modules/core/missing-person/service/missing-person-export.service.ts',
"""      if (job.content) {
        await this.prisma.missingPersonExportJob.update({ where: { id }, data: { content: null } });
      }""",
"""      if (job.content) {
        await this.prisma.missingPersonExportJob.update({ where: { id }, data: { content: null } });
        this.missingPersonCommonService.emitAudit({
          actorType: ActorType.SYSTEM,
          action: AuditEventEnum.MISSING_PERSON_EXPORT_EXPIRED,
          entity: 'MissingPersonExportJob',
          entityId: id,
        });
      }""", imports=[AT, AE])

# 3. support export sweep
replace_once('support export expiry',
 'modules/core/support/service/support-export.service.ts',
"""      await this.prisma.supportExportJob.updateMany({
        where: { status: SupportExportJobStatus.COMPLETED, expiresAt: { lt: new Date(now) } },
        data: { status: SupportExportJobStatus.EXPIRED, csv: null },
      });""",
"""      const expired = await this.prisma.supportExportJob.updateMany({
        where: { status: SupportExportJobStatus.COMPLETED, expiresAt: { lt: new Date(now) } },
        data: { status: SupportExportJobStatus.EXPIRED, csv: null },
      });
      if (expired.count > 0) {
        this.supportCommonService.emitAudit({
          actorType: ActorType.SYSTEM,
          action: AuditEventEnum.SUPPORT_EXPORT_EXPIRED,
          entity: 'SupportExportJob',
          metadata: { expiredJobs: expired.count },
        });
      }""", imports=[AT, AE])

# 4. information-submission attachment rows rebuilt during a GET
rel = 'modules/core/information-submission/service/information-submission-media-admin.service.ts'
replace_once('attachment sync: removed rows', rel,
"""    await this.prisma.informationAttachment.deleteMany({
      where: { submissionId: submission.id, key: { notIn: keys } },
    });
    if (!keys.length) return;""",
"""    const removed = await this.prisma.informationAttachment.deleteMany({
      where: { submissionId: submission.id, key: { notIn: keys } },
    });
    if (removed.count > 0) {
      this.informationSubmissionCommonService.emitAudit({
        actorType: ActorType.SYSTEM,
        action: AuditEventEnum.INFORMATION_SUBMISSION_ATTACHMENTS_SYNCED,
        entity: 'InformationSubmission',
        entityId: submission.id,
        metadata: { removed: removed.count },
      });
    }
    if (!keys.length) return;""", imports=[AT, AE])
replace_once('attachment sync: added rows (start)', rel,
"""    await this.prisma.informationAttachment.createMany({
      data: missing.map((key, i) => {""",
"""    const created = await this.prisma.informationAttachment.createMany({
      data: missing.map((key, i) => {""")
replace_once('attachment sync: added rows (end)', rel,
"""      skipDuplicates: true,
    });
  }

  async listAttachments(id: string) {""",
"""      skipDuplicates: true,
    });
    if (created.count > 0) {
      this.informationSubmissionCommonService.emitAudit({
        actorType: ActorType.SYSTEM,
        action: AuditEventEnum.INFORMATION_SUBMISSION_ATTACHMENTS_SYNCED,
        entity: 'InformationSubmission',
        entityId: submission.id,
        metadata: { added: created.count },
      });
    }
  }

  async listAttachments(id: string) {""")

# 5. victim profile: verified / privacy reviewed / approved gates
replace_once('victim profile gates: verified, privacy reviewed, approved',
 'modules/core/victim-profile/service/victim-profile-review.service.ts',
"""      metadata: { consentNewlyRecorded },
    });
""",
"""      metadata: { consentNewlyRecorded },
    });

    // Each approval gate that was just switched on also gets its own audit action.
    const gatesSwitchedOn: Array<[boolean, AuditEventEnum]> = [
      [!profile.isVerified && isVerified, AuditEventEnum.VICTIM_PROFILE_VERIFIED],
      [
        !profile.isPrivacyReviewed && isPrivacyReviewed,
        AuditEventEnum.VICTIM_PROFILE_PRIVACY_REVIEWED,
      ],
      [!profile.isAdminApproved && isAdminApproved, AuditEventEnum.VICTIM_PROFILE_APPROVED],
    ];
    for (const [switchedOn, gateAction] of gatesSwitchedOn) {
      if (!switchedOn) continue;
      this.victimProfileCommonService.emitAudit({
        userId: admin.id,
        ...this.victimProfileCommonService.targetUserFor(admin, profile),
        actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
        action: gateAction,
        entity: 'VictimProfile',
        entityId: id,
        entityLabel: this.victimProfileCommonService.profileLabel(profile),
        diff: { result: 'success', previousStatus: profile.status, newStatus: status },
      });
    }
""")

print('\n%s' % ('DRY RUN (no files written)' if DRY else 'APPLIED'))
print('  changed: %d   already done: %d   needs attention: %d' % (len(OK), len(SKIP), len(FAIL)))
for l, w in OK: print('  + %s  [%s]' % (l, w))
for l, w in SKIP: print('  = %s  (%s)' % (l, w))
for l, w in FAIL: print('  ! %s: %s' % (l, w))
print("""
Not wired because no code path exists: REPORT_SYNCED (nothing syncs reports),
USER_EXPORT_EXPIRED (user exports are only time-checked, never rewritten on expiry),
MISSING_PERSON_REDACTED (redaction is only requested, never completed, in this code).
Next: npx tsc --noEmit""")
sys.exit(1 if FAIL else 0)
