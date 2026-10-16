import { Inject, Injectable } from '@nestjs/common';
import type { CommissionRateRule } from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { commissionOf } from '../domain/commission';
import { TooManyQueriesError } from '../domain/errors';
import { RATE_REPOSITORY, type RateRepository } from '../domain/ports';

export const RATE_QUERY_MAX = 500;

export interface RateAsOfQueryDto {
  shopId: string;
  category: string;
  validAt: Date;
}

export interface PriceLineInput {
  shopId: string;
  category: string;
  lineTotalMinor: number;
}

export interface PricedLineDto extends PriceLineInput {
  rateBps: number;
  commissionMinor: number;
}

export interface RateAsOfDto extends RateAsOfQueryDto {
  rateBps: number;
  rule: CommissionRateRule;
}

/**
 * R1 export of the rates (S16 Provides): batch only, DTOs only, never a model. The answer has the length and order of
 * the input and always resolves (the default covers all time); `knownAt` defaults to now and is never in the future.
 */
@Injectable()
export class CommissionRateQueryService {
  constructor(
    @Inject(RATE_REPOSITORY) private readonly rates: RateRepository,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Rate and commission of each sale line as of the sale's `paidAt` (the answer has the length and order of the input):
   * the one pricing the ledger books at settlement and the statement reports, `commissionOf` per line (S16.R-04).
   */
  async priceLines(
    lines: PriceLineInput[],
    paidAt: Date,
  ): Promise<PricedLineDto[]> {
    const rates = await this.getRatesAsOf(
      lines.map((l) => ({
        shopId: l.shopId,
        category: l.category,
        validAt: paidAt,
      })),
    );
    return lines.map((l, i) => ({
      ...l,
      rateBps: rates[i].rateBps,
      commissionMinor: commissionOf(l.lineTotalMinor, rates[i].rateBps),
    }));
  }

  async getRatesAsOf(
    queries: RateAsOfQueryDto[],
    knownAt?: Date,
  ): Promise<RateAsOfDto[]> {
    if (queries.length > RATE_QUERY_MAX)
      throw new TooManyQueriesError(RATE_QUERY_MAX);
    const now = this.clock.now();
    const at = knownAt && knownAt.getTime() < now.getTime() ? knownAt : now;
    const normalised = queries.map((q) => ({
      ...q,
      category: q.category.trim().toLowerCase(),
    }));
    const answers = await this.rates.asOfBatch(normalised, at);
    return queries.map((q, i) => ({
      shopId: q.shopId,
      category: q.category,
      validAt: q.validAt,
      rateBps: answers[i].rateBps,
      rule: answers[i].rule,
    }));
  }
}
