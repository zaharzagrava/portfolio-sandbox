import { Inject, Injectable, Logger } from '@nestjs/common';
import { DOCUMENT_REPOSITORY, OBJECT_STORE } from '../domain/ports';
import type {
  ByteRemoval,
  DocumentRepository,
  ObjectStore,
} from '../domain/ports';

const BATCH = 200;

/**
 * Removal of the documents of a product or a shop that was deleted (S47 FR-012, AS-50, AS-51). Replaces the database
 * cascade the foreign keys used to give: batches of 200, each batch one transaction that tombstones the documents and
 * deletes their passages; the stored bytes go after the commit and a failure is left to the sweep. Repeating it finds
 * nothing left to do (the events are delivered at least once).
 */
@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    @Inject(DOCUMENT_REPOSITORY) private readonly documents: DocumentRepository,
    @Inject(OBJECT_STORE) private readonly store: ObjectStore,
  ) {}

  purgeByProduct(productId: string): Promise<number> {
    return this.purge({ productId });
  }

  purgeByShop(shopId: string): Promise<number> {
    return this.purge({ shopId });
  }

  private async purge(
    by: { productId: string } | { shopId: string },
  ): Promise<number> {
    let total = 0;
    for (;;) {
      const batch = await this.documents.purgeBatch(by, BATCH);
      total += batch.length;
      await this.removeBytes(batch);
      if (batch.length < BATCH) return total;
    }
  }

  private async removeBytes(batch: ByteRemoval[]): Promise<void> {
    for (const row of batch) {
      try {
        await this.store.delete(row.storageKey);
        await this.documents.markBytesRemoved(row.id);
      } catch (error) {
        this.logger.warn(
          `stored bytes of ${row.id} not removed: ${(error as Error).name}`,
        );
      }
    }
  }
}
