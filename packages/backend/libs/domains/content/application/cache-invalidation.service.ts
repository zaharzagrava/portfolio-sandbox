import { Inject, Injectable, Logger } from '@nestjs/common';
import { PermanentError } from '@app/infrastructure/projections/errors';
import { LIMITS } from '../domain/limits';
import {
  CDN_PURGER,
  CdnPermanentError,
  READ_MODEL,
  REVALIDATION_CLIENT,
  type CdnPurger,
  type ReadModel,
  type RevalidationClient,
} from '../domain/ports';

export interface TagBatch {
  tags: string[];
  /** The event that contributed the first tag of the batch; it names the batch to the front end. */
  eventId: string;
}

/**
 * The three cache layers behind one story change (S27 FR-031): the origin entry, the CDN (by tag) and the front end's
 * route cache (signed revalidation). Used by the invalidation consumer and by the shop copy (suspension, deletion).
 * Both outbound targets are attempted for every batch whatever the other did (FR-032); the failure is raised after.
 */
@Injectable()
export class CacheInvalidationService {
  private readonly logger = new Logger('StoryInvalidation');

  constructor(
    @Inject(READ_MODEL) private readonly readModel: ReadModel,
    @Inject(CDN_PURGER) private readonly cdn: CdnPurger,
    @Inject(REVALIDATION_CLIENT)
    private readonly revalidation: RevalidationClient,
  ) {}

  clearOrigin(shopSlug: string, slug: string): Promise<void> {
    return this.readModel.del(shopSlug, slug);
  }

  /** Distinct tags in first-seen order, cut into calls of at most 30 (FR-031). */
  batches(tagsByEvent: { eventId: string; tags: string[] }[]): TagBatch[] {
    const seen = new Set<string>();
    const ordered: { tag: string; eventId: string }[] = [];
    for (const { eventId, tags } of tagsByEvent)
      for (const tag of tags)
        if (!seen.has(tag)) {
          seen.add(tag);
          ordered.push({ tag, eventId });
        }
    const out: TagBatch[] = [];
    for (let i = 0; i < ordered.length; i += LIMITS.tagsPerCall) {
      const chunk = ordered.slice(i, i + LIMITS.tagsPerCall);
      out.push({ tags: chunk.map((c) => c.tag), eventId: chunk[0].eventId });
    }
    return out;
  }

  /**
   * Purges the CDN and calls the front end for every batch. A permanent CDN refusal (bad credentials) becomes a
   * `PermanentError` (dead letter, alert-worthy log); anything else that failed is a `TransientError` (redelivery).
   */
  async purge(batches: TagBatch[]): Promise<void> {
    let permanent = false;
    let failed = false;
    for (const batch of batches) {
      try {
        await this.cdn.purgeTags(batch.tags);
      } catch (error) {
        failed = true;
        if (error instanceof CdnPermanentError) permanent = true;
      }
      try {
        await this.revalidation.revalidate(batch.tags, batch.eventId);
      } catch {
        failed = true;
      }
    }
    if (permanent) {
      this.logger.error(
        'alert: the CDN refused the purge for good (credentials?); the invalidation is dead-lettered',
      );
      throw new PermanentError('cdn purge refused');
    }
    if (failed) throw new InvalidationIncompleteError();
  }
}

/**
 * A target failed and may succeed on redelivery. Deliberately not a `TransientError`: that pauses the partition and
 * never dead-letters, while S27 FR-032 wants the framework's attempt budget (8 deliveries) and then the dead letter.
 */
export class InvalidationIncompleteError extends Error {
  constructor() {
    super('cache invalidation incomplete');
    this.name = 'InvalidationIncompleteError';
  }
}
