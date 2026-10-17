import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { buffer } from 'node:stream/consumers';
import * as Y from 'yjs';
import { CLOCK, type Clock } from '@app/common/core/clock';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';
import { DRAFT_LIMITS } from '../domain/draft-limits';
import { DraftNotFoundError } from '../domain/draft-errors';
import {
  DRAFT_REPOSITORY,
  SNAPSHOT_STORE,
  SUPERSEDED_REGISTRY,
  SequenceConflictError,
  StoreUnavailableError,
  type DocStore,
  type DraftRepository,
  type LoadedDoc,
  type SnapshotStore,
  type SupersededRegistry,
} from '../domain/draft-ports';
import { withTimeout } from './timeouts';

const pk = (draftId: string) => `DOC#${draftId}`;
const SUPERSEDED_PK = 'SUPERSEDED';
const PAGE = 100;

export const snapshotKeyFor = (draftId: string, seq: number) =>
  `drafts/${draftId}/snap-${String(seq).padStart(12, '0')}`;

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.byteLength === b.byteLength && Buffer.compare(a, b) === 0;

/** S3 / MinIO adapter of `SnapshotStore`: every call is bounded by the 3 s object store timeout. */
@Injectable()
export class S3SnapshotStore implements SnapshotStore {
  constructor(private readonly storage: ObjectStorage) {}

  put(key: string, bytes: Uint8Array): Promise<void> {
    return withTimeout('snapshot put', DRAFT_LIMITS.s3TimeoutMs, () =>
      this.storage.put(key, Buffer.from(bytes), 'application/octet-stream', {
        timeoutMs: DRAFT_LIMITS.s3TimeoutMs,
      }),
    );
  }

  get(key: string): Promise<Uint8Array> {
    return withTimeout('snapshot get', DRAFT_LIMITS.s3TimeoutMs, async () => {
      const stream = await this.storage.getStream(key, {
        timeoutMs: DRAFT_LIMITS.s3TimeoutMs,
      });
      return new Uint8Array(await buffer(stream));
    });
  }

  delete(key: string): Promise<void> {
    return withTimeout('snapshot delete', DRAFT_LIMITS.s3TimeoutMs, () =>
      this.storage.delete(key),
    );
  }

  deletePrefix(prefix: string): Promise<number> {
    return withTimeout('snapshot delete prefix', DRAFT_LIMITS.s3TimeoutMs, () =>
      this.storage.deletePrefix(prefix, {
        timeoutMs: DRAFT_LIMITS.s3TimeoutMs,
        limit: 1000,
      }),
    );
  }

  list(prefix: string) {
    return withTimeout('snapshot list', DRAFT_LIMITS.s3TimeoutMs * 3, () =>
      this.storage.list(prefix),
    );
  }
}

/** Superseded snapshot keys in the `DocUpdates` table (partition `SUPERSEDED`, sort key = the instant they become deletable). */
@Injectable()
export class DynamoSupersededRegistry implements SupersededRegistry {
  constructor(private readonly dynamo: DynamoService) {}

  private table() {
    return this.dynamo.table('DocUpdates');
  }

  async record(key: string, eligibleAt: Date): Promise<void> {
    let token = eligibleAt.getTime();
    for (let attempt = 0; attempt < 20; attempt++, token++) {
      try {
        await withTimeout(
          'superseded record',
          DRAFT_LIMITS.dynamoTimeoutMs,
          () =>
            this.dynamo.doc.send(
              new PutCommand({
                TableName: this.table(),
                Item: { PK: SUPERSEDED_PK, SK: token, key },
                ConditionExpression: 'attribute_not_exists(SK)',
              }),
              {
                abortSignal: AbortSignal.timeout(DRAFT_LIMITS.dynamoTimeoutMs),
              },
            ),
        );
        return;
      } catch (error) {
        const cause = (error as Error & { cause?: Error }).cause;
        if (cause?.name !== 'ConditionalCheckFailedException') throw error;
      }
    }
  }

  async due(now: Date, limit: number) {
    const page = await withTimeout(
      'superseded query',
      DRAFT_LIMITS.dynamoTimeoutMs,
      () =>
        this.dynamo.doc.send(
          new QueryCommand({
            TableName: this.table(),
            KeyConditionExpression: 'PK = :pk AND SK <= :now',
            ExpressionAttributeValues: {
              ':pk': SUPERSEDED_PK,
              ':now': now.getTime(),
            },
            Limit: limit,
            ConsistentRead: true,
          }),
          { abortSignal: AbortSignal.timeout(DRAFT_LIMITS.dynamoTimeoutMs) },
        ),
    );
    return (page.Items ?? []).map((i) => ({
      key: i.key as string,
      token: Number(i.SK),
    }));
  }

  async remove(token: number): Promise<void> {
    await withTimeout('superseded remove', DRAFT_LIMITS.dynamoTimeoutMs, () =>
      this.dynamo.doc.send(
        new DeleteCommand({
          TableName: this.table(),
          Key: { PK: SUPERSEDED_PK, SK: token },
        }),
        { abortSignal: AbortSignal.timeout(DRAFT_LIMITS.dynamoTimeoutMs) },
      ),
    );
  }
}

interface LogItem {
  SK: number;
  update: Uint8Array;
  grp?: number;
  part?: number;
  parts?: number;
}

/**
 * Durable state of a collaborative doc = a snapshot object (full state at `snapshotSeq`) + the DynamoDB log (merged
 * updates with seq > snapshotSeq). Usable from ANY process: Yjs updates are commutative and idempotent, so snapshot + tail
 * in any order gives the same document. Every call has a timeout (Dynamo 1 s, S3 3 s); a failure is a
 * `StoreUnavailableError` and the caller keeps what it wanted to write.
 */
@Injectable()
export class DraftStore implements DocStore {
  private readonly logger = new Logger(DraftStore.name);

  constructor(
    private readonly dynamo: DynamoService,
    @Inject(DRAFT_REPOSITORY) private readonly drafts: DraftRepository,
    @Inject(SNAPSHOT_STORE) private readonly snapshots: SnapshotStore,
    @Inject(SUPERSEDED_REGISTRY)
    private readonly superseded: SupersededRegistry,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private table() {
    return this.dynamo.table('DocUpdates');
  }

  private send<T>(operation: string, run: (signal: AbortSignal) => Promise<T>) {
    return withTimeout(operation, DRAFT_LIMITS.dynamoTimeoutMs, () =>
      run(AbortSignal.timeout(DRAFT_LIMITS.dynamoTimeoutMs)),
    );
  }

  async load(shopId: string, draftId: string): Promise<LoadedDoc> {
    const draft = await this.drafts.findInShop(shopId, draftId);
    if (!draft) throw new DraftNotFoundError();

    const doc = new Y.Doc();
    if (draft.snapshotKey)
      Y.applyUpdate(doc, await this.snapshots.get(draft.snapshotKey));

    let seq = draft.snapshotSeq;
    let tailLength = 0;
    let startKey: Record<string, unknown> | undefined;
    let open: { grp: number; chunks: Uint8Array[]; parts: number } | null =
      null;
    do {
      const page = await this.send('log query', (abortSignal) =>
        this.dynamo.doc.send(
          new QueryCommand({
            TableName: this.table(),
            KeyConditionExpression: 'PK = :pk AND SK > :seq',
            ExpressionAttributeValues: {
              ':pk': pk(draftId),
              ':seq': draft.snapshotSeq,
            },
            ExclusiveStartKey: startKey,
            Limit: PAGE,
            ConsistentRead: true,
          }),
          { abortSignal },
        ),
      );
      for (const item of (page.Items ?? []) as LogItem[]) {
        seq = Math.max(seq, Number(item.SK));
        tailLength++;
        if (item.parts === undefined || item.parts <= 1) {
          open = null;
          Y.applyUpdate(doc, item.update);
        } else if (item.part === 0) {
          open = {
            grp: Number(item.grp),
            chunks: [item.update],
            parts: item.parts,
          };
        } else if (
          open &&
          open.grp === Number(item.grp) &&
          item.part === open.chunks.length
        ) {
          open.chunks.push(item.update);
          if (open.chunks.length === open.parts) {
            Y.applyUpdate(doc, Buffer.concat(open.chunks));
            open = null;
          }
        } else open = null; // a broken group was never acknowledged; clients resend what it held
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return { doc, seq, tailLength };
  }

  async append(
    draftId: string,
    fromSeq: number,
    update: Uint8Array,
  ): Promise<number> {
    const size = DRAFT_LIMITS.logEntryBytes;
    const count = Math.max(1, Math.ceil(update.byteLength / size));
    for (let i = 0; i < count; i++) {
      const item: LogItem & { PK: string; at: number } = {
        PK: pk(draftId),
        SK: fromSeq + i,
        update: update.subarray(i * size, (i + 1) * size),
        at: this.clock.nowMs(),
        ...(count > 1 ? { grp: fromSeq, part: i, parts: count } : {}),
      };
      await this.putEntry(draftId, item);
    }
    return fromSeq + count - 1;
  }

  /** Conditional put; an entry that already holds identical bytes (a retry after a lost acknowledgement) is a success. */
  private async putEntry(
    draftId: string,
    item: LogItem & { PK: string; at: number },
  ): Promise<void> {
    try {
      await this.send('log put', (abortSignal) =>
        this.dynamo.doc.send(
          new PutCommand({
            TableName: this.table(),
            Item: item,
            ConditionExpression: 'attribute_not_exists(SK)',
          }),
          { abortSignal },
        ),
      );
    } catch (error) {
      const cause = (error as Error & { cause?: Error }).cause;
      if (cause?.name !== 'ConditionalCheckFailedException') throw error;
      const existing = await this.send('log get', (abortSignal) =>
        this.dynamo.doc.send(
          new GetCommand({
            TableName: this.table(),
            Key: { PK: item.PK, SK: item.SK },
            ConsistentRead: true,
          }),
          { abortSignal },
        ),
      );
      const found = existing.Item as LogItem | undefined;
      const same =
        found !== undefined &&
        sameBytes(found.update, item.update) &&
        found.grp === item.grp &&
        found.part === item.part &&
        found.parts === item.parts;
      if (!same) throw new SequenceConflictError(draftId, item.SK);
    }
  }

  async compact(
    shopId: string,
    draftId: string,
    doc: Y.Doc,
    seq: number,
  ): Promise<void> {
    const key = snapshotKeyFor(draftId, seq);
    await this.snapshots.put(key, Y.encodeStateAsUpdate(doc));
    const { moved, previousKey } = await this.drafts.moveSnapshotPointer(
      shopId,
      draftId,
      key,
      seq,
    );
    const grace = new Date(this.clock.nowMs() + DRAFT_LIMITS.supersededGraceMs);
    if (!moved) {
      // A lower sequence number never moves the pointer back; the object just written is not referenced. Entries up to the
      // stored pointer are covered by its snapshot, so a trim that a crash cut short is finished here.
      await this.superseded.record(key, grace);
      const current = await this.drafts.findInShop(shopId, draftId);
      if (current && current.snapshotSeq > 0)
        await this.trim(draftId, current.snapshotSeq);
      return;
    }
    if (previousKey) await this.superseded.record(previousKey, grace);
    const trimmed = await this.trim(draftId, seq);
    this.logger.debug(
      `compacted ${draftId} at seq ${seq} (${trimmed} log items trimmed)`,
    );
  }

  /** Deletes log entries up to `seq`, 100 keys at a time; nothing is accumulated in memory. */
  private async trim(draftId: string, seq: number): Promise<number> {
    let total = 0;
    for (;;) {
      const page = await this.send('log trim query', (abortSignal) =>
        this.dynamo.doc.send(
          new QueryCommand({
            TableName: this.table(),
            KeyConditionExpression: 'PK = :pk AND SK <= :seq',
            ExpressionAttributeValues: { ':pk': pk(draftId), ':seq': seq },
            ProjectionExpression: 'SK',
            Limit: PAGE,
            ConsistentRead: true,
          }),
          { abortSignal },
        ),
      );
      const keys = (page.Items ?? []).map((i) => Number(i.SK));
      if (keys.length === 0) return total;
      await this.deleteKeys(draftId, keys);
      total += keys.length;
    }
  }

  private async deleteKeys(draftId: string, keys: number[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 25) {
      let pending = keys.slice(i, i + 25).map((sk) => ({
        DeleteRequest: { Key: { PK: pk(draftId), SK: sk } },
      }));
      for (let attempt = 0; pending.length > 0; attempt++) {
        if (attempt >= 5) throw new StoreUnavailableError('log trim');
        const out = await this.send('log trim delete', (abortSignal) =>
          this.dynamo.doc.send(
            new BatchWriteCommand({
              RequestItems: { [this.table()]: pending },
            }),
            { abortSignal },
          ),
        );
        pending = (out.UnprocessedItems?.[this.table()] ??
          []) as typeof pending;
      }
    }
  }

  async seed(shopId: string, draftId: string, doc: Y.Doc): Promise<void> {
    const key = snapshotKeyFor(draftId, 0);
    await this.snapshots.put(key, Y.encodeStateAsUpdate(doc));
    await this.drafts.setSeedPointer(shopId, draftId, key);
  }

  async purge(draftId: string): Promise<void> {
    await this.trim(draftId, Number.MAX_SAFE_INTEGER);
    while ((await this.snapshots.deletePrefix(`drafts/${draftId}/`)) > 0);
  }
}
