import { Inject, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import {
  draftCreateRequestSchema,
  type Draft,
  type DraftConnect,
  type DraftPage,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  decodeDraftCursor,
  draftListScope,
  encodeDraftCursor,
} from '../domain/draft-cursor';
import {
  CollabUnavailableError,
  DraftInvalidTransitionError,
  DraftLimitReachedError,
  DraftNotFoundError,
  DraftValidationError,
  PublishInProgressError,
} from '../domain/draft-errors';
import { parseDraftListQuery, parseWith } from '../domain/draft-input';
import { DRAFT_LIMITS } from '../domain/draft-limits';
import {
  COLLAB_BACKPLANE,
  DOC_STORE,
  DRAFT_MEMBERSHIP,
  DRAFT_REPOSITORY,
  PRODUCT_GATEWAY,
  RING_REGISTRY,
  type Backplane,
  type DocStore,
  type DraftRecord,
  type DraftRepository,
  type MembershipReader,
  type ProductGateway,
  type RingRegistry,
} from '../domain/draft-ports';
import { applyDraftTransition } from '../domain/draft-status';
import { parseSpecs, seedListing } from '../domain/listing-doc';
import { ProductArchivedError } from '../domain/product-errors';
import { InvalidCursorError } from '../domain/product-errors';
import { DraftTicketService } from './draft-ticket.service';

export const toDraftView = (record: DraftRecord): Draft => ({
  id: record.id,
  shopId: record.shopId,
  productId: record.productId,
  title: record.title,
  status: record.status,
  baseProductVersion: record.baseProductVersion,
  createdBy: record.createdBy,
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
  publishedAt: record.publishedAt ? record.publishedAt.toISOString() : null,
});

/**
 * Drafts as records (S06): create (blank or from a product), list, archive and connect. Publish and versions are separate
 * services. The shop is in every predicate and another shop's draft is the same `404` as an unknown one.
 */
@Injectable()
export class DraftsService {
  constructor(
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    @Inject(DOC_STORE) private readonly docs: DocStore,
    @Inject(PRODUCT_GATEWAY) private readonly products: ProductGateway,
    @Inject(DRAFT_MEMBERSHIP) private readonly membership: MembershipReader,
    @Inject(RING_REGISTRY) private readonly ring: RingRegistry,
    @Inject(COLLAB_BACKPLANE) private readonly backplane: Backplane,
    private readonly tickets: DraftTicketService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(shopId: string, actorId: string, body: unknown): Promise<Draft> {
    const parsed = parseWith(draftCreateRequestSchema, body);
    if (!parsed.ok) throw new DraftValidationError(parsed.fields);
    const { title, productId } = parsed.value;

    const product = productId
      ? await this.products.get(shopId, productId)
      : null;
    if (product?.status === 'ARCHIVED') throw new ProductArchivedError();

    const record = await this.drafts.insertWithinCap(
      {
        id: uuidv7(),
        shopId,
        productId: product?.id ?? null,
        baseProductVersion: product?.version ?? null,
        title,
        createdBy: actorId,
        now: this.clock.now(),
      },
      DRAFT_LIMITS.openDraftsPerShop,
    );
    if (!record) throw new DraftLimitReachedError();

    if (product) {
      const { description, specs } = parseSpecs(product.description);
      try {
        await this.docs.seed(
          shopId,
          record.id,
          seedListing({
            title: product.title,
            description,
            priceMinor: product.priceMinor,
            brand: product.brand,
            category: product.category,
            quantity: product.quantity,
            specs,
          }),
        );
      } catch (error) {
        // A draft that cannot start with its product's content must not exist half made.
        await this.drafts.deleteByIds(shopId, [record.id]);
        throw error;
      }
    }
    return toDraftView(record);
  }

  async list(
    shopId: string,
    query: Record<string, unknown>,
  ): Promise<DraftPage> {
    const parsed = parseDraftListQuery(query ?? {});
    if (!parsed.ok) throw new DraftValidationError(parsed.fields);
    const { status, limit, cursor } = parsed.value;
    const scope = draftListScope(shopId, status);
    const after = cursor === null ? null : decodeDraftCursor(cursor, scope);
    if (cursor !== null && !after) throw new InvalidCursorError();
    const found = await this.drafts.listByShop(
      shopId,
      status,
      after,
      limit + 1,
    );
    const page = found.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => toDraftView(row.record)),
      nextCursor:
        found.length > limit && last
          ? encodeDraftCursor(last.key, scope)
          : null,
    };
  }

  async archive(shopId: string, draftId: string): Promise<Draft> {
    const current = await this.mustFind(shopId, draftId);
    this.assertTransition(current, 'ARCHIVED');
    const archived = await this.drafts.transition({
      shopId,
      draftId,
      from: 'DRAFT',
      to: 'ARCHIVED',
      now: this.clock.now(),
    });
    if (!archived) {
      // Someone else moved the draft between the read and the update: say why from the row as it is now.
      const now = await this.mustFind(shopId, draftId);
      this.assertTransition(now, 'ARCHIVED');
      throw new DraftInvalidTransitionError(now.status);
    }
    await this.backplane.publish({
      type: 'close-draft',
      draftId,
      reason: 'draft_closed',
    });
    return toDraftView(archived);
  }

  /** Where to connect plus a 60 second ticket bound to this draft, shop, user and permission level. */
  async connect(
    shopId: string,
    draftId: string,
    userId: string,
  ): Promise<DraftConnect> {
    const draft = await this.mustFind(shopId, draftId);
    const access = await this.membership.accessOf(shopId, userId);
    if (access.kind !== 'member') throw new DraftNotFoundError();
    const owner = await this.ring.ownerOf(draftId);
    if (!owner) throw new CollabUnavailableError();
    const canWrite = access.ability === 'write' && draft.status === 'DRAFT';
    const { ticket, expiresAt } = this.tickets.issue({
      userId,
      shopId,
      draftId,
      canWrite,
    });
    return {
      url: `${owner.url}/collab/${draftId}`,
      ticket,
      canWrite,
      expiresAt: expiresAt.toISOString(),
    };
  }

  private async mustFind(
    shopId: string,
    draftId: string,
  ): Promise<DraftRecord> {
    const found = await this.drafts.findInShop(shopId, draftId);
    if (!found) throw new DraftNotFoundError();
    return found;
  }

  private assertTransition(record: DraftRecord, to: 'ARCHIVED') {
    const move = applyDraftTransition(record.status, to);
    if (move.ok) return;
    throw move.code === 'publish_in_progress'
      ? new PublishInProgressError()
      : new DraftInvalidTransitionError(move.currentStatus);
  }
}
