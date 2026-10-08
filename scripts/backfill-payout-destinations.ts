import { PrismaClient } from '@prisma/client';

const APPLY = process.argv.includes('--apply');
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

type Legacy = { id: string; name: string | null; number: string | null; bank: string | null };

async function loadBanks(): Promise<Map<string, string>> {
  const key = process.env.CHAPA_SECRET_KEY;
  if (!key) throw new Error('CHAPA_SECRET_KEY is required to match bank codes');
  const base = process.env.CHAPA_BASE_URL ?? 'https://api.chapa.co/v1';
  const res = await fetch(`${base}/banks`, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(`Chapa /banks failed: ${res.status}`);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  const map = new Map<string, string>();
  for (const b of body.data) {
    if (b.is_mobilemoney === 1 || b.is_mobilemoney === true) continue;
    map.set(norm(String(b.name)), String(b.id));
  }
  return map;
}

async function main() {
  const prisma = new PrismaClient();
  const banks = await loadBanks();

  let profiles: Legacy[];
  try {
    profiles = await prisma.$queryRaw<Legacy[]>`
      SELECT vp.id, vp."bankAccountName" AS name, vp."bankAccountNumber" AS number, vp."bankName" AS bank
      FROM victim_profile vp
      LEFT JOIN payout_destinations pd ON pd."victimProfileId" = vp.id
      WHERE vp."bankAccountNumber" IS NOT NULL AND pd.id IS NULL`;
  } catch (e) {
    console.error('Legacy bank columns are not in the database any more. Nothing to backfill from.');
    throw e;
  }

  let created = 0;
  const unmatched: string[] = [];
  const incomplete: string[] = [];

  for (const p of profiles) {
    if (!p.name || !p.number) {
      incomplete.push(p.id);
      continue;
    }
    const bankCode = p.bank ? (banks.get(norm(p.bank)) ?? null) : null;
    if (!bankCode) unmatched.push(p.id);
    if (APPLY) {
      await prisma.payoutDestination.create({
        data: {
          rail: 'BANK',
          bankName: p.bank,
          bankCode,
          accountNumber: p.number,
          accountHolder: p.name,
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
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
