import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import {
  PICKUP_AVAILABILITY_INDEX,
  type PickupAvailabilityIndex,
} from '../domain/pickup-ports';

export const PICKUP_INDEX_STRICT = Symbol('PICKUP_INDEX_STRICT');

/**
 * Creates the index mapping at start-up, idempotently (two starters at once both end with one index). In the
 * projector (`strict`) an unreachable engine fails the start, so readiness reports it instead of a swallowed warning
 * (S19 A19); in the API a down engine only means searches answer `503` until it is back.
 */
@Injectable()
export class PickupIndexBootstrap implements OnModuleInit {
  private readonly logger = new Logger(PickupIndexBootstrap.name);

  constructor(
    @Inject(PICKUP_AVAILABILITY_INDEX)
    private readonly index: PickupAvailabilityIndex,
    @Inject(PICKUP_INDEX_STRICT) private readonly strict: boolean,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.index.ensureIndex();
    } catch (error) {
      if (this.strict) throw error;
      this.logger.warn(
        `pickup index mapping not ensured: ${(error as Error).message}`,
      );
    }
  }
}
