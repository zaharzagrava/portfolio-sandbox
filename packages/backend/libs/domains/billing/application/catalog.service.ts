import { Inject, Injectable } from '@nestjs/common';
import { CATALOG_REPOSITORY, type CatalogRepository } from '../domain/ports';
import {
  planCodeTaken,
  planNotFound,
  priceAlreadyRetired,
  priceNotFound,
} from '../domain/errors';
import type {
  Audience,
  EntitlementValues,
  PlanRow,
  PriceRow,
} from '../domain/types';
import type { BillingInterval } from '../domain/periods';

/**
 * The catalog (S17 FR-001 to FR-006): plans, versioned prices and retirement. A price is never edited: publishing is
 * inserting the next version, and the store (`billing_price_immutable`) refuses any other change.
 */
@Injectable()
export class CatalogService {
  constructor(
    @Inject(CATALOG_REPOSITORY) private readonly catalog: CatalogRepository,
  ) {}

  list() {
    return this.catalog.listActive();
  }

  async createPlan(input: {
    code: string;
    name: string;
    audience: Audience;
    entitlements: EntitlementValues;
  }): Promise<PlanRow> {
    const plan = await this.catalog.insertPlan(input);
    if (!plan) throw planCodeTaken();
    return plan;
  }

  async publishPrice(
    planId: string,
    input: {
      interval: BillingInterval;
      unitAmountMinor: number;
      currency: string;
      perSeat: boolean;
      trialDays: number;
      includedUsage: Record<string, number>;
      overagePer1000Minor: Record<string, number>;
    },
  ): Promise<PriceRow> {
    if (!(await this.catalog.findPlan(planId))) throw planNotFound();
    return this.catalog.insertPrice(planId, input);
  }

  async retirePrice(priceId: string): Promise<{ id: string; active: false }> {
    const outcome = await this.catalog.retirePrice(priceId);
    if (outcome === 'missing') throw priceNotFound();
    if (outcome === 'already_retired') throw priceAlreadyRetired();
    return { id: priceId, active: false };
  }
}
