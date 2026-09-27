// src/modules/billing/dto/fx.dto.ts
//
// GAP 7 (FX handling). Section 29 of the standard: whenever money crosses a
// currency boundary between what the payer paid in and what a recipient is
// paid out in, the exact rate/source/timestamp used must be recorded next to
// the money, not just the converted number — so this snapshot is stored,
// immutable, alongside the AllocationLine it applies to, and (for the
// remainder line) mirrored onto Payment's own fxRate/fxRateCapturedAt/
// settlementCurrency columns, which already existed — see the schema note
// at the bottom of this file.
//
// The standard is explicit: "do not silently convert". If no live rate is
// available, AllocationService must hard-fail rather than fabricate one of
// these — see fx-rate.provider.ts. Nothing in this codebase should ever
// construct an FxSnapshotDto from a guessed, cached-past-expiry, or stale
// rate.

import { IsISO8601, IsString, Matches } from 'class-validator';

const DECIMAL = /^-?\d+(\.\d+)?$/;
const CURRENCY_CODE = /^[A-Z]{3}$/; // ISO 4217, e.g. "ETB", "USD"

export class FxSnapshotDto {
  /** Units of destinationCurrency per 1 sourceCurrency, exactly as quoted by rateSource. */
  @Matches(DECIMAL)
  rate!: string;

  /** When rateSource quoted this rate — not when the conversion was computed. */
  @IsISO8601()
  rateTimestamp!: Date;

  /** Which feed produced the rate, e.g. "chapa", "nbe-manual", "openexchangerates". */
  @IsString()
  rateSource!: string;

  @Matches(CURRENCY_CODE)
  sourceCurrency!: string;

  @Matches(CURRENCY_CODE)
  destinationCurrency!: string;

  /** sourceAmount * rate, in destinationCurrency, BEFORE roundingAdjustment. Decimal string. */
  @Matches(DECIMAL)
  convertedAmount!: string;

  /**
   * Signed. destinationCurrency's smallest unit can't always divide the
   * converted amount evenly (e.g. the rate carries more precision than the
   * payout currency has decimal places) — this is the leftover applied so
   * the amount actually disbursed is exact. "0" when no adjustment was needed.
   */
  @Matches(DECIMAL)
  roundingAdjustment!: string;
}

/**
 * Same currency-code check FxSnapshotDto uses, exported separately so
 * fx-rate.provider.ts and allocation.service.ts can validate a currency code
 * without instantiating the whole DTO.
 */
export const CURRENCY_CODE_PATTERN = CURRENCY_CODE;

// ─────────────────────────────────────────────────────────────────────────
// SCHEMA NOTE — checked against the real schema (prisma/schema/payment.prisma):
// Payment ALREADY has fxRate (Decimal(18,8)), fxRateCapturedAt (DateTime),
// and settlementCurrency (String) — "only populated when payout/settlement
// currency differs from the transaction currency ... never silently
// converted" per that file's own header comment, which matches this DTO's
// intent exactly. PaymentAllocation and Disbursement have no per-line FX
// columns, so AllocationService (see allocation.service.ts) computes ONE
// FxSnapshotDto per preview — for whichever line is the true remainder
// (RECIPIENT for SUPPORT) — not one per line; the full snapshot for every
// line, including any institution-linked rule lines, is still recorded
// inside Payment.allocationSnapshot (Json, already existed).
//
// Two fields this DTO needs that Payment does NOT yet have — additive,
// nullable, no backfill required:
//   fxRateSource          String?
//   fxRoundingAdjustment  Decimal?  @db.Decimal(14, 2)
//
// See the migration + schema edit in
// prisma/schema/migrations/20260927120000_gap7_fx_and_gap8_institution_kyc/
// and payment.prisma.
// ─────────────────────────────────────────────────────────────────────────