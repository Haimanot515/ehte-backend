/**
 * One-off backfill: copy legacy VictimProfile bank fields into PayoutDestination.
 *
 * Run AFTER the `bankCode` migration and BEFORE (or together with) deploying the new code:
 *   npx ts-node scripts/backfill-payout-destinations.ts            # dry run (default)
 *   npx ts-node scripts/backfill-payout-destinations.ts --apply    # write
 *
 * Rules
 *  - Only profiles that have no PayoutDestination yet are touched.
 *  - Every created row is isVerified=false. Old-design verification is NOT carried over;
 *    an admin must re-enter/confirm and a DIFFERENT admin must verify.
 *  - bankCode is matched to Chapa's bank list by exact (case-insensitive) name.
 *    Unmatched profiles still get a row (bankCode null) and are listed for manual re-entry
 *    through PATCH admin/:id/bank-details.
 *  - Existing PayoutDestination rows are never modified.
 *
 * Needs env: DATABASE_URL, CHAPA_SECRET_KEY (optional CHAPA_BASE_URL).
 */
import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

async function loadBanks(): Promise<Map<string, string>> {
  const key = process.env.CHAPA_SECRET_KEY;
  if (!key) throw new Error('CHAPA_SECRET_KEY is required to match bank codes');
  const base = process.env.CHAPA_BASE_URL ?? 'https://api.chapa.co/v1';
  const res = await fetch(`${base}/banks`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Chapa /banks failed: ${res.status}`);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  const map = new Map<string, string>();
  for (const b of body.data) {
    if (b.is_mobilemoney === 1 || b.is_mobilemoney === true) continue; // wallets are not bank rails
    map.set(norm(String(b.name)), String(b.id));
  }
  return map;
}

async function main() {
  const prisma = new PrismaClient();
  const banks = await loadBanks();

  const profiles = await prisma.victimProfile.findMany({
    where: {
      bankAccountNumber: { not: null },
      payoutDestination: { is: null },
    },
    select: { id: true, bankAccountName: true, bankAccountNumber: true, bankName: true },
  });

  let created = 0;
  const unmatched: string[] = [];
  const incomplete: string[] = [];

  for (const p of profiles) {
    if (!p.bankAccountName || !p.bankAccountNumber) {
      incomplete.push(p.id);
      continue;
    }
    const bankCode = p.bankName ? (banks.get(norm(p.bankName)) ?? null) : null;
    if (!bankCode) unmatched.push(p.id);

    if (APPLY) {
      await prisma.payoutDestination.create({
        data: {
          rail: 'BANK',
          bankName: p.bankName,
          bankCode,
          accountNumber: p.bankAccountNumber,
          accountHolder: p.bankAccountName,
          isVerified: false,
          victimProfileId: p.id,
        },
      });
    }
    created++;
  }

  console.log(`${APPLY ? 'CREATED' : 'WOULD CREATE'} ${created} payout destinations`);
  console.log(`Missing bankCode (re-enter via admin bank-details): ${unmatched.length}`);
  unmatched.forEach((id) => console.log(`  ${id}`));
  console.log(`Skipped, missing account name/number: ${incomplete.length}`);
  incomplete.forEach((id) => console.log(`  ${id}`));

  // Divergence report for rows that already existed (legacy copy differs from destination)
  const diverged = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT vp.id FROM victim_profile vp
    JOIN payout_destinations pd ON pd."victimProfileId" = vp.id
    WHERE vp."bankAccountNumber" IS DISTINCT FROM pd."accountNumber"`;
  console.log(`Existing destinations that differ from the legacy copy: ${diverged.length}`);
  diverged.forEach((r) => console.log(`  ${r.id}`));

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
