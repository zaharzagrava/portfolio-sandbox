import { Inject, Injectable, Logger } from '@nestjs/common';
import { withTimeout } from '../domain/with-timeout';
import {
  FLAG_REPOSITORY,
  RULESET_PUBLISHER,
  type FlagRepository,
  type RulesetPublisher,
} from '../domain/ports';
import { flagsPublishFailuresTotal } from './flags-metrics';

export const PUBLISH_TIMEOUT_MS = 500;

/**
 * Publishes the ruleset after a change has committed (R-7): the snapshot is built from the database (never from the
 * writer's memory), written to the cache only if newer, and announced by its version. The whole call is bounded by
 * 500 ms; a failure is counted and logged and never reaches the caller, because the change is already committed and the
 * repair job and the SDKs' polling converge on the database truth (FR-031).
 */
@Injectable()
export class RulesetPublisherService {
  private readonly logger = new Logger(RulesetPublisherService.name);

  constructor(
    @Inject(FLAG_REPOSITORY) private readonly flags: FlagRepository,
    @Inject(RULESET_PUBLISHER) private readonly publisher: RulesetPublisher,
  ) {}

  /** Never throws. Resolves `true` when the snapshot was handed to the cache and the push went out. */
  async publish(): Promise<boolean> {
    try {
      await withTimeout(
        this.flags
          .loadSnapshot()
          .then((snapshot) => this.publisher.publish(snapshot)),
        PUBLISH_TIMEOUT_MS,
        'ruleset publication',
      );
      return true;
    } catch (error) {
      flagsPublishFailuresTotal.add(1);
      this.logger.warn(
        `ruleset publication failed (repair and polling will converge): ${(error as Error).message}`,
      );
      return false;
    }
  }
}
