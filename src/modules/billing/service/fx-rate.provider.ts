// src/modules/billing/service/fx-rate.provider.ts
//
// GAP 7: no live FX rate source exists yet. The standard says AllocationService
// must hard-fail rather than guess a rate when a payout currency differs from
// the transaction currency — this file IS that hard-fail, isolated behind an
// interface so wiring in a real feed later (NBE, Chapa, openexchangerates,
// whatever the business picks) means implementing FxRateProvider and swapping
// the provider binding in billing.module.ts, not touching AllocationService.

import { Injectable } from '@nestjs/common';
import { CURRENCY_CODE_PATTERN } from '../dto/fx.dto';

export class FxRateUnavailableException extends Error {
  readonly sourceCurrency: string;
  readonly destinationCurrency: string;

  constructor(sourceCurrency: string, destinationCurrency: string, cause?: unknown) {
    super(`No FX rate available for ${sourceCurrency}->${destinationCurrency}`);
    this.name = 'FxRateUnavailableException';
    this.sourceCurrency = sourceCurrency;
    this.destinationCurrency = destinationCurrency;
    if (cause !== undefined) this.cause = cause as Error;
  }
}

export type FxRateQuote = {
  /** Decimal string. Units of destinationCurrency per 1 sourceCurrency. */
  rate: string;
  /** When the feed quoted this rate — not when getRate() was called. */
  rateTimestamp: Date;
  /** Identifies the feed, e.g. "chapa", "nbe-manual". Stored verbatim on FxSnapshotDto. */
  rateSource: string;
};

export interface FxRateProvider {
  /**
   * Must throw FxRateUnavailableException rather than return a guessed,
   * stale, or cached-past-expiry rate — AllocationService relies on that to
   * satisfy the standard's "do not silently convert" requirement.
   */
  getRate(sourceCurrency: string, destinationCurrency: string): Promise<FxRateQuote>;
}

/** DI token — inject with @Inject(FX_RATE_PROVIDER). */
export const FX_RATE_PROVIDER = Symbol('FX_RATE_PROVIDER');

/**
 * Default binding until a real feed is chosen (see file header). Always
 * throws. This makes "no provider configured" a concrete, typed failure
 * instead of something AllocationService has to special-case itself —
 * same reasoning as G27's getBalance() needing a typed error so callers
 * can distinguish "not implemented" from "the provider is down".
 */
@Injectable()
export class UnconfiguredFxRateProvider implements FxRateProvider {
  async getRate(sourceCurrency: string, destinationCurrency: string): Promise<FxRateQuote> {
    if (!CURRENCY_CODE_PATTERN.test(sourceCurrency) || !CURRENCY_CODE_PATTERN.test(destinationCurrency)) {
      throw new FxRateUnavailableException(sourceCurrency, destinationCurrency);
    }
    throw new FxRateUnavailableException(sourceCurrency, destinationCurrency);
  }
}