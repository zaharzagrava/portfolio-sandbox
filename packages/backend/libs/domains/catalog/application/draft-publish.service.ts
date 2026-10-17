import { Inject, Injectable, Logger } from '@nestjs/common';
import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';
import {
  draftPublishRequestSchema,
  type DraftPublishResult,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import {
  DraftInvalidTransitionError,
  DraftNotFoundError,
  DraftValidationError,
  ListingInvalidError,
  ProductGoneError,
  ProductVersionConflictError,
  PublishInProgressError,
} from '../domain/draft-errors';
import { parseWith } from '../domain/draft-input';
import { DRAFT_LIMITS } from '../domain/draft-limits';
import {
  COLLAB_BACKPLANE,
  COLLAB_CONTROL,
  DOC_STORE,
  DRAFT_REPOSITORY,
  PRODUCT_GATEWAY,
  SNAPSHOT_STORE,
  StoreUnavailableError,
  VERSION_REPOSITORY,
  type Backplane,
  type CollabControl,
  type DocStore,
  type DraftRecord,
  type DraftRepository,
  type ProductFields,
  type ProductGateway,
  type ProductSnapshotView,
  type SnapshotStore,
  type VersionRepository,
} from '../domain/draft-ports';
import { applyDraftTransition } from '../domain/draft-status';
import { readListing } from '../domain/listing-doc';
import { validateListing } from '../domain/listing-validation';
import {
  ProductArchivedError,
  ProductNotFoundError,
  VersionConflictError,
} from '../domain/product-errors';
import { draftPublishCounter } from './draft-metrics';
import { DraftPublished } from './events/draft-events';
import { versionObjectKey } from './draft-versions.service';
import { CollabUnavailableError } from '../domain/draft-errors';

type Outcome =
  'published' | 'unchanged' | 'conflict' | 'invalid' | 'failed' | 'unavailable';

/** `Published 2026-03-01 10:00`: the UTC date and minute of the (shared) clock. */
const versionName = (at: Date) =>
  `Published ${at.toISOString().slice(0, 10)} ${at.toISOString().slice(11, 16)}`;

/**
 * Publish: turn a draft into a product (new) or a product revision (S06 US4). One path, exactly once:
 *
 *  1. claim `DRAFT -> PUBLISHING` with a 60 s lease (a conditional update; of simultaneous publishes one proceeds);
 *  2. freeze the room through its owning instance (3 s) and read the frozen state;
 *  3. validate with the limits of S05; write the snapshot object BEFORE the transaction (no network call inside it);
 *  4. one transaction: `ProductCommandService` create/update, the `published` version row, `PUBLISHING -> PUBLISHED`
 *     on the lease id, and the `catalog.draft_published` event;
 *  5. on any failure release the claim (lease-guarded) before the answer, so the draft is editable again.
 */
@Injectable()
export class DraftPublishService {
  private readonly logger = new Logger(DraftPublishService.name);

  constructor(
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    @Inject(VERSION_REPOSITORY) private readonly versions: VersionRepository,
    @Inject(DOC_STORE) private readonly docs: DocStore,
    @Inject(SNAPSHOT_STORE) private readonly snapshots: SnapshotStore,
    @Inject(COLLAB_CONTROL) private readonly collab: CollabControl,
    @Inject(PRODUCT_GATEWAY) private readonly products: ProductGateway,
    @Inject(COLLAB_BACKPLANE) private readonly backplane: Backplane,
    private readonly runner: TransactionRunner,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async publish(
    shopId: string,
    draftId: string,
    actorId: string,
    body: unknown,
  ): Promise<DraftPublishResult> {
    const parsed = parseWith(draftPublishRequestSchema, body ?? {});
    if (!parsed.ok) throw new DraftValidationError(parsed.fields);
    const { acknowledgeProductVersion } = parsed.value;

    const draft = await this.drafts.findInShop(shopId, draftId);
    if (!draft) throw new DraftNotFoundError();
    this.assertClaimable(draft);

    const leaseId = uuidv7();
    const claimed = await this.drafts.transition({
      shopId,
      draftId,
      from: 'DRAFT',
      to: 'PUBLISHING',
      leaseId,
      leaseExpiresAt: new Date(
        this.clock.nowMs() + DRAFT_LIMITS.publishLeaseMs,
      ),
      now: this.clock.now(),
    });
    if (!claimed) {
      // Lost the race: say why from the row as it is now.
      const now = await this.drafts.findInShop(shopId, draftId);
      if (!now) throw new DraftNotFoundError();
      this.assertClaimable(now);
      throw new PublishInProgressError();
    }

    let outcome: Outcome = 'failed';
    try {
      const result = await this.run(
        claimed,
        leaseId,
        actorId,
        acknowledgeProductVersion,
      );
      outcome = result.unchanged ? 'unchanged' : 'published';
      draftPublishCounter.add(1, { outcome });
      // The draft is closed for editing: every open room of it closes (4005), whichever instance holds it.
      await this.backplane.publish({
        type: 'close-draft',
        draftId,
        reason: 'draft_closed',
      });
      return result.body;
    } catch (error) {
      outcome = this.classify(error);
      draftPublishCounter.add(1, { outcome });
      await this.release(shopId, draftId, leaseId);
      throw this.translate(error);
    }
  }

  private assertClaimable(draft: DraftRecord): void {
    const move = applyDraftTransition(draft.status, 'PUBLISHING');
    if (move.ok) return;
    throw move.code === 'publish_in_progress'
      ? new PublishInProgressError()
      : new DraftInvalidTransitionError(move.currentStatus);
  }

  private async run(
    draft: DraftRecord,
    leaseId: string,
    actorId: string,
    acknowledge: number | undefined,
  ): Promise<{ body: DraftPublishResult; unchanged: boolean }> {
    await this.collab.freeze(draft.id, leaseId);
    const { doc } = await this.docs.load(draft.shopId, draft.id);
    const content = readListing(doc);
    const fieldsMap = doc.getMap('fields');
    const check = validateListing(content, (key) => fieldsMap.has(key));
    if (!check.ok) throw new ListingInvalidError(check.errors);
    const bytes = Y.encodeStateAsUpdate(doc);
    doc.destroy();

    // The product the draft targets must still be there and active; its version decides whether the draft is stale.
    let current: ProductSnapshotView | null = null;
    let expectedVersion = 0;
    if (draft.productId) {
      current = await this.products.get(draft.shopId, draft.productId);
      if (current.status === 'ARCHIVED') throw new ProductArchivedError();
      if (acknowledge === undefined) {
        expectedVersion = draft.baseProductVersion ?? current.version;
        if (current.version !== expectedVersion)
          throw new ProductVersionConflictError(current.version);
      } else {
        expectedVersion = current.version;
        if (acknowledge !== current.version)
          throw new ProductVersionConflictError(current.version);
      }
    }

    // The snapshot object is written before the transaction: no network call while a connection is held. An object whose
    // transaction fails is an orphan that the daily job removes.
    const versionId = uuidv7();
    const objectKey = versionObjectKey(versionId);
    await this.snapshots.put(objectKey, bytes);

    const now = this.clock.now();
    const committed = await this.runner.run(async () => {
      let product: ProductSnapshotView;
      let unchanged = false;
      if (!draft.productId) {
        product = await this.products.create(
          draft.shopId,
          actorId,
          check.fields,
        );
      } else {
        const changed = diffFields(current!, check.fields);
        const written = await this.products.update(
          draft.shopId,
          draft.productId,
          actorId,
          expectedVersion,
          changed,
        );
        product = written.product;
        unchanged = written.unchanged;
      }
      await this.versions.insertPublished({
        id: versionId,
        draftId: draft.id,
        shopId: draft.shopId,
        name: versionName(now),
        kind: 'published',
        objectKey,
        createdBy: actorId,
        now,
      });
      const done = await this.drafts.transition({
        shopId: draft.shopId,
        draftId: draft.id,
        from: 'PUBLISHING',
        to: 'PUBLISHED',
        leaseId,
        productId: product.id,
        now,
      });
      // A publisher that lost its lease completes nothing: the whole transaction, product write included, is rolled back.
      if (!done) throw new PublishInProgressError();
      await this.outbox.append(
        DraftPublished.create(draft.id, 1, {
          draftId: draft.id,
          shopId: draft.shopId,
          productId: product.id,
          productVersion: product.version,
          versionId,
          publishedBy: actorId,
        }),
      );
      return { product, unchanged };
    });

    return {
      unchanged: committed.unchanged,
      body: {
        productId: committed.product.id,
        productVersion: committed.product.version,
        versionId,
      },
    };
  }

  /** Back to `DRAFT` (only while this publisher still holds the lease) and let the room accept writes again. */
  private async release(shopId: string, draftId: string, leaseId: string) {
    try {
      await this.drafts.transition({
        shopId,
        draftId,
        from: 'PUBLISHING',
        to: 'DRAFT',
        leaseId,
        now: this.clock.now(),
      });
    } catch (error) {
      // The job returns the draft to DRAFT when the lease expires.
      this.logger.error({
        msg: 'release failed',
        event: 'publish_release_failed',
        draftId,
        error: (error as Error).name,
      });
    }
    await this.collab.unfreeze(draftId, leaseId).catch(() => undefined);
  }

  private classify(error: unknown): Outcome {
    if (error instanceof ListingInvalidError) return 'invalid';
    if (
      error instanceof ProductVersionConflictError ||
      error instanceof VersionConflictError ||
      error instanceof ProductArchivedError ||
      error instanceof ProductNotFoundError
    )
      return 'conflict';
    if (
      error instanceof CollabUnavailableError ||
      error instanceof StoreUnavailableError
    )
      return 'unavailable';
    return 'failed';
  }

  /** S05's refusals become the publish answers of contracts/http.md. */
  private translate(error: unknown): unknown {
    if (error instanceof VersionConflictError)
      return new ProductVersionConflictError(error.currentVersion);
    if (error instanceof ProductNotFoundError) return new ProductGoneError();
    if (error instanceof StoreUnavailableError)
      return new CollabUnavailableError(error);
    return error;
  }
}

/** The fields that differ from the product as it is now (S06 FR-026: only changed fields are sent). */
function diffFields(
  current: ProductSnapshotView,
  next: ProductFields,
): Partial<ProductFields> {
  const changes: Partial<ProductFields> = {};
  for (const key of [
    'title',
    'description',
    'brand',
    'category',
    'priceMinor',
    'quantity',
  ] as const)
    if (current[key] !== next[key])
      (changes as Record<string, unknown>)[key] = next[key];
  return changes;
}
