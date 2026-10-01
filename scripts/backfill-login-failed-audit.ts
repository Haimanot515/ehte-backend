import 'dotenv/config';
import { createHash } from 'crypto';
import { AuditOutcome, AuditSeverity, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

const LOCK_KEY = 7_301_001;
const HASH_VERSION = 'v1';
const BATCH = 2_000;

const apply = process.argv.includes('--apply');
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg(process.env.DATABASE_URL) });

type HashInput = {
  seq: number;
  prevHash: string | null;
  createdAt: Date;
  action: string;
  outcome: string;
  severity: string;
  actorType: string;
  entity: string;
  entityId: string | null;
  reason: string | null;
};

function computeHash(r: HashInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        HASH_VERSION,
        r.seq,
        r.prevHash ?? 'GENESIS',
        r.createdAt.toISOString(),
        r.action,
        r.outcome,
        r.severity,
        r.actorType,
        r.entity,
        r.entityId,
        r.reason,
      ]),
    )
    .digest('hex');
}

async function main() {
  const targets = await prisma.auditLog.findMany({
    where: { action: 'LOGIN_FAILED', outcome: AuditOutcome.SUCCESS },
    select: { id: true, seq: true },
    orderBy: { createdAt: 'asc' },
  });

  const chainedSeqs = targets.map((t) => t.seq).filter((s): s is number => s !== null);
  console.log(`Rows to correct: ${targets.length} (chained: ${chainedSeqs.length})`);

  if (!apply) {
    console.log('Dry run only. Re-run with --apply to write changes.');
    return;
  }

  if (targets.length === 0) return;

  const firstSeq = chainedSeqs.length > 0 ? Math.min(...chainedSeqs) : null;

  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LOCK_KEY})`;

      await tx.auditLog.updateMany({
        where: { id: { in: targets.map((t) => t.id) } },
        data: { outcome: AuditOutcome.FAILURE, severity: AuditSeverity.WARNING },
      });

      if (firstSeq === null) return;

      const pred = await tx.auditLog.findFirst({
        where: { seq: { lt: firstSeq } },
        orderBy: { seq: 'desc' },
        select: { hash: true },
      });

      // Every chained row from the first corrected one onward is re-linked so verification passes.
      let prevHash: string | null = pred?.hash ?? null;
      let cursor = firstSeq - 1;
      let relinked = 0;

      for (;;) {
        const rows = await tx.auditLog.findMany({
          where: { seq: { gt: cursor } },
          orderBy: { seq: 'asc' },
          take: BATCH,
          select: {
            id: true,
            seq: true,
            hash: true,
            prevHash: true,
            createdAt: true,
            action: true,
            outcome: true,
            severity: true,
            actorType: true,
            entity: true,
            entityId: true,
            reason: true,
          },
        });

        if (rows.length === 0) break;

        for (const row of rows) {
          const seq = row.seq as number;
          const hash = computeHash({ ...row, seq, prevHash });

          if (row.prevHash !== prevHash || row.hash !== hash) {
            await tx.auditLog.update({ where: { id: row.id }, data: { prevHash, hash } });
            relinked += 1;
          }

          prevHash = hash;
          cursor = seq;
        }
      }

      console.log(`Chain rows re-linked: ${relinked}`);
    },
    { timeout: 300_000 },
  );

  console.log(`Corrected ${targets.length} rows.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());