import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/sequelize';
import { QueryTypes, Sequelize } from 'sequelize';
import {
  BatchWriteCommand,
  PutCommand,
  QueryCommand,
  QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';
import { buffer } from 'node:stream/consumers';
import * as Y from 'yjs';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { ObjectStorage } from '@app/infrastructure/storage/object-storage.port';

const pk = (draftId: string) => `DOC#${draftId}`;

export interface LoadedDoc {
  doc: Y.Doc;
  seq: number;
  tailLength: number;
}

/**
 * Durable state of a collaborative doc = S3 snapshot (full state at
 * `snapshotSeq`) + DynamoDB tail (merged updates with seq > snapshotSeq).
 * Usable from ANY process (the collab room, the core API's publish/version
 * endpoints), because Yjs updates are commutative and idempotent: applying
 * snapshot + tail in any order gives the same document.
 */
@Injectable()
export class DraftStore {
  private readonly logger = new Logger(DraftStore.name);

  constructor(
    @InjectConnection() private readonly sequelize: Sequelize,
    private readonly dynamo: DynamoService,
    private readonly storage: ObjectStorage,
  ) {}

  async load(draftId: string): Promise<LoadedDoc> {
    const [draft] = await this.sequelize.query<{
      snapshotKey: string | null;
      snapshotSeq: string;
    }>(
      `SELECT "snapshotKey", "snapshotSeq" FROM "ListingDraft" WHERE id = :draftId`,
      {
        type: QueryTypes.SELECT,
        replacements: { draftId },
      },
    );
    if (!draft) throw new NotFoundException('Draft not found');

    const doc = new Y.Doc();
    if (draft.snapshotKey)
      Y.applyUpdate(
        doc,
        new Uint8Array(
          await buffer(await this.storage.getStream(draft.snapshotKey)),
        ),
      );
    let seq = Number(draft.snapshotSeq);
    let tailLength = 0;
    let startKey: QueryCommandOutput['LastEvaluatedKey'];
    do {
      const page = await this.dynamo.doc.send(
        new QueryCommand({
          TableName: this.table(),
          KeyConditionExpression: 'PK = :pk AND SK > :seq',
          ExpressionAttributeValues: {
            ':pk': pk(draftId),
            ':seq': Number(draft.snapshotSeq),
          },
          ExclusiveStartKey: startKey,
          ConsistentRead: true,
        }),
      );
      for (const item of page.Items ?? []) {
        Y.applyUpdate(doc, item.update as Uint8Array);
        seq = Math.max(seq, Number(item.SK));
        tailLength++;
      }
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    return { doc, seq, tailLength };
  }

  /**
   * Conditional put: if another instance already wrote this seq (two rooms for
   * one doc during a ring change), this fails loudly - the caller reloads
   * instead of silently forking the log.
   */
  async append(
    draftId: string,
    seq: number,
    update: Uint8Array,
  ): Promise<void> {
    try {
      await this.dynamo.doc.send(
        new PutCommand({
          TableName: this.table(),
          Item: { PK: pk(draftId), SK: seq, update, at: Date.now() },
          ConditionExpression: 'attribute_not_exists(SK)',
        }),
      );
    } catch (error) {
      if ((error as Error).name === 'ConditionalCheckFailedException')
        throw new ConflictException(`seq ${seq} of ${draftId} already written`);
      throw error;
    }
  }

  /** Snapshot the full state at `seq`, move the pointer forward (never back), trim the log. */
  async compact(draftId: string, doc: Y.Doc, seq: number): Promise<void> {
    const key = `drafts/${draftId}/snapshots/${String(seq).padStart(12, '0')}.ybin`;
    await this.storage.put(
      key,
      Buffer.from(Y.encodeStateAsUpdate(doc)),
      'application/octet-stream',
    );
    const [, meta] = await this.sequelize.query(
      `UPDATE "ListingDraft" SET "snapshotKey" = :key, "snapshotSeq" = :seq, "updatedAt" = now() WHERE id = :draftId AND "snapshotSeq" < :seq`,
      { replacements: { key, seq, draftId } },
    );
    if (!(meta as { rowCount?: number })?.rowCount) return;

    let startKey: QueryCommandOutput['LastEvaluatedKey'];
    const doomed: number[] = [];
    do {
      const page = await this.dynamo.doc.send(
        new QueryCommand({
          TableName: this.table(),
          KeyConditionExpression: 'PK = :pk AND SK <= :seq',
          ExpressionAttributeValues: { ':pk': pk(draftId), ':seq': seq },
          ProjectionExpression: 'SK',
          ExclusiveStartKey: startKey,
        }),
      );
      doomed.push(...(page.Items ?? []).map((i) => Number(i.SK)));
      startKey = page.LastEvaluatedKey;
    } while (startKey);
    for (let i = 0; i < doomed.length; i += 25) {
      await this.dynamo.doc.send(
        new BatchWriteCommand({
          RequestItems: {
            [this.table()]: doomed.slice(i, i + 25).map((sk) => ({
              DeleteRequest: { Key: { PK: pk(draftId), SK: sk } },
            })),
          },
        }),
      );
    }
    this.logger.debug(
      `compacted ${draftId} at seq ${seq} (${doomed.length} log items trimmed)`,
    );
  }

  /** Initial content (e.g. from an existing product) as the seq-0 snapshot. */
  async seed(draftId: string, doc: Y.Doc): Promise<void> {
    const key = `drafts/${draftId}/snapshots/${'0'.repeat(12)}.ybin`;
    await this.storage.put(
      key,
      Buffer.from(Y.encodeStateAsUpdate(doc)),
      'application/octet-stream',
    );
    await this.sequelize.query(
      `UPDATE "ListingDraft" SET "snapshotKey" = :key WHERE id = :draftId`,
      { replacements: { key, draftId } },
    );
  }

  private table() {
    return this.dynamo.table('DocUpdates');
  }
}
