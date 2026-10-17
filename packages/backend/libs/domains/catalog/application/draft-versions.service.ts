import { Inject, Injectable } from '@nestjs/common';
import * as Y from 'yjs';
import { v7 as uuidv7 } from 'uuid';
import {
  draftVersionCreateRequestSchema,
  type DraftVersion,
  type DraftVersionDetail,
  type DraftVersionPage,
} from '@marketplace-sandbox/contracts';
import { CLOCK, type Clock } from '@app/common/core/clock';
import {
  decodeDraftCursor,
  encodeDraftCursor,
  versionListScope,
} from '../domain/draft-cursor';
import {
  DraftInvalidTransitionError,
  DraftNotFoundError,
  DraftValidationError,
  VersionLimitReachedError,
  VersionNotFoundError,
  VersionUnavailableError,
} from '../domain/draft-errors';
import { parseVersionListQuery, parseWith } from '../domain/draft-input';
import { DRAFT_LIMITS } from '../domain/draft-limits';
import {
  COLLAB_CONTROL,
  DOC_STORE,
  DRAFT_REPOSITORY,
  SNAPSHOT_STORE,
  StoreUnavailableError,
  VERSION_REPOSITORY,
  type CollabControl,
  type DocStore,
  type DraftRepository,
  type SnapshotStore,
  type VersionRecord,
  type VersionRepository,
} from '../domain/draft-ports';
import { readListing } from '../domain/listing-doc';
import { InvalidCursorError } from '../domain/product-errors';
import {
  collabStoreErrorCounter,
  draftVersionUnavailableCounter,
} from './draft-metrics';

const toVersionView = (record: VersionRecord): DraftVersion => ({
  id: record.id,
  name: record.name,
  kind: record.kind,
  createdBy: record.createdBy,
  createdAt: record.createdAt.toISOString(),
});

export const versionObjectKey = (versionId: string) => `versions/${versionId}`;

/**
 * Named versions of a draft (S06 US5): an immutable snapshot of the room state taken after a flush barrier through the
 * owning instance. The content lives in an object (`versions/<id>`), the metadata in a row; a snapshot that cannot be read
 * is `503 version_unavailable`, never a storage message.
 */
@Injectable()
export class DraftVersionsService {
  constructor(
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    @Inject(VERSION_REPOSITORY) private readonly versions: VersionRepository,
    @Inject(DOC_STORE) private readonly docs: DocStore,
    @Inject(SNAPSHOT_STORE) private readonly snapshots: SnapshotStore,
    @Inject(COLLAB_CONTROL) private readonly collab: CollabControl,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async create(
    shopId: string,
    draftId: string,
    actorId: string,
    body: unknown,
  ): Promise<DraftVersion> {
    const parsed = parseWith(draftVersionCreateRequestSchema, body);
    if (!parsed.ok) throw new DraftValidationError(parsed.fields);
    const draft = await this.drafts.findInShop(shopId, draftId);
    if (!draft) throw new DraftNotFoundError();
    if (draft.status !== 'DRAFT')
      throw new DraftInvalidTransitionError(draft.status);

    // Flush barrier: what the room received before this call is in the log before the state is read.
    await this.collab.flush(draftId);
    const id = uuidv7();
    const objectKey = versionObjectKey(id);
    try {
      const { doc } = await this.docs.load(shopId, draftId);
      await this.snapshots.put(objectKey, Y.encodeStateAsUpdate(doc));
      doc.destroy();
    } catch (error) {
      if (error instanceof StoreUnavailableError)
        throw new VersionUnavailableError(error);
      throw error;
    }

    const record = await this.versions.insertWithinCap(
      {
        id,
        draftId,
        shopId,
        name: parsed.value.name,
        kind: 'named',
        objectKey,
        createdBy: actorId,
        now: this.clock.now(),
      },
      DRAFT_LIMITS.versionsPerDraft,
    );
    if (!record) {
      await this.snapshots.delete(objectKey).catch(() => undefined);
      throw new VersionLimitReachedError();
    }
    return toVersionView(record);
  }

  async list(
    shopId: string,
    draftId: string,
    query: Record<string, unknown>,
  ): Promise<DraftVersionPage> {
    const parsed = parseVersionListQuery(query ?? {});
    if (!parsed.ok) throw new DraftValidationError(parsed.fields);
    if (!(await this.drafts.findInShop(shopId, draftId)))
      throw new DraftNotFoundError();
    const { limit, cursor } = parsed.value;
    const scope = versionListScope(shopId, draftId);
    const after = cursor === null ? null : decodeDraftCursor(cursor, scope);
    if (cursor !== null && !after) throw new InvalidCursorError();
    const found = await this.versions.list(shopId, draftId, after, limit + 1);
    const page = found.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => toVersionView(row.record)),
      nextCursor:
        found.length > limit && last
          ? encodeDraftCursor(last.key, scope)
          : null,
    };
  }

  async get(
    shopId: string,
    draftId: string,
    versionId: string,
  ): Promise<DraftVersionDetail> {
    if (!(await this.drafts.findInShop(shopId, draftId)))
      throw new DraftNotFoundError();
    const record = await this.versions.findInDraft(shopId, draftId, versionId);
    if (!record) throw new VersionNotFoundError();
    let bytes: Uint8Array;
    try {
      bytes = await this.snapshots.get(record.objectKey);
    } catch (error) {
      draftVersionUnavailableCounter.add(1);
      collabStoreErrorCounter.add(1, { operation: 'version_read' });
      throw new VersionUnavailableError(error as Error);
    }
    const doc = new Y.Doc();
    try {
      Y.applyUpdate(doc, bytes);
    } catch (error) {
      draftVersionUnavailableCounter.add(1);
      throw new VersionUnavailableError(error as Error);
    }
    const content = readListing(doc);
    doc.destroy();
    return {
      ...toVersionView(record),
      content: {
        title: content.title,
        description: content.description,
        priceMinor: content.priceMinor ?? null,
        brand: content.brand ?? null,
        category: content.category ?? null,
        quantity: content.quantity ?? null,
        specs: content.specs,
      },
    };
  }
}
