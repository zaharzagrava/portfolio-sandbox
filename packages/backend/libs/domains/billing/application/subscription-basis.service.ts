import { Inject, Injectable } from '@nestjs/common';
import {
  SUBSCRIPTION_REPOSITORY,
  type LiveBasisRow,
  type SubscriptionRepository,
} from '../domain/ports';
import type { SubjectType } from '../domain/types';

export type SubscriptionBasis = Omit<LiveBasisRow, 'subjectId'>;

const MAX_IDS = 500;

/**
 * What S18 needs to build a subject's entitlements (S17 contracts, "Exported service"): the subscription that is live
 * for entitlements (`TRIALING`, `ACTIVE`, `PAST_DUE`; `UNPAID` and `CANCELED` give `null`), read from committed state
 * only. Replaces S18's own join over billing's tables.
 */
@Injectable()
export class SubscriptionBasisService {
  constructor(
    @Inject(SUBSCRIPTION_REPOSITORY)
    private readonly subscriptions: SubscriptionRepository,
  ) {}

  async getLiveBasis(
    subjectType: SubjectType,
    subjectId: string,
  ): Promise<SubscriptionBasis | null> {
    return (
      (await this.getLiveBasisBySubjectIds(subjectType, [subjectId])).get(
        subjectId,
      ) ?? null
    );
  }

  async getLiveBasisBySubjectIds(
    subjectType: SubjectType,
    ids: string[],
  ): Promise<Map<string, SubscriptionBasis>> {
    const unique = [...new Set(ids)];
    if (unique.length > MAX_IDS)
      throw new RangeError(`at most ${MAX_IDS} subjects per call`);
    const rows = await this.subscriptions.liveBasis(subjectType, unique);
    return new Map(rows.map(({ subjectId, ...basis }) => [subjectId, basis]));
  }
}
