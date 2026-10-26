import { SharedRecordType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

export interface SharedRecordInfo {
  exists: boolean;
  ownerId: string | null;
  contactPhone: string | null;
}

const MISSING: SharedRecordInfo = { exists: false, ownerId: null, contactPhone: null };

// Looks up a record by its shared entity type and returns whether it exists and who owns it
export async function findSharedRecord(
  prisma: PrismaService,
  entity: SharedRecordType,
  id: string,
): Promise<SharedRecordInfo> {
  switch (entity) {
    case SharedRecordType.REPORT: {
      const row = await prisma.report.findUnique({ where: { id }, select: { userId: true } });
      return row ? { exists: true, ownerId: row.userId, contactPhone: null } : MISSING;
    }
    case SharedRecordType.POST: {
      const row = await prisma.post.findUnique({ where: { id }, select: { userId: true } });
      return row ? { exists: true, ownerId: row.userId, contactPhone: null } : MISSING;
    }
    case SharedRecordType.MISSING_PERSON: {
      const row = await prisma.missingPerson.findUnique({
        where: { id },
        select: { userId: true, contactPhone: true },
      });
      return row ? { exists: true, ownerId: row.userId, contactPhone: row.contactPhone } : MISSING;
    }
    case SharedRecordType.VICTIM_PROFILE: {
      const row = await prisma.victimProfile.findUnique({
        where: { id },
        select: { createdByUserId: true },
      });
      return row ? { exists: true, ownerId: row.createdByUserId, contactPhone: null } : MISSING;
    }
    case SharedRecordType.INFORMATION_SUBMISSION: {
      const row = await prisma.informationSubmission.findUnique({
        where: { id },
        select: { userId: true },
      });
      return row ? { exists: true, ownerId: row.userId, contactPhone: null } : MISSING;
    }
    default:
      return MISSING;
  }
}

// Turns a list of user ids into an id -> name map for staff-facing screens
export async function namesByUserId(prisma: PrismaService, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (unique.length === 0) return new Map<string, string | null>();
  const users = await prisma.user.findMany({
    where: { id: { in: unique } },
    select: { id: true, name: true },
  });
  return new Map(users.map((u) => [u.id, u.name]));
}

// Parses an Accept-Language style value into an ordered list of language codes
export function parseLanguages(raw: string | string[] | undefined | null): string[] {
  if (!raw) return [];
  const text = Array.isArray(raw) ? raw.join(',') : raw;
  const parsed = text
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam ? Number(qParam.trim().slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((p) => p.tag && p.tag !== '*' && p.q > 0)
    .sort((a, b) => b.q - a.q);

  const out: string[] = [];
  for (const { tag } of parsed) {
    if (!out.includes(tag)) out.push(tag);
    const base = tag.split('-')[0];
    if (base && !out.includes(base)) out.push(base);
  }
  return out;
}
