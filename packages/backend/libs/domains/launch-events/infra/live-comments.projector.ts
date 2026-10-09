import { Injectable } from '@nestjs/common';
import {
  BatchWriteCommand,
  BatchWriteCommandInput,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { sleep } from '@app/common/core/backoff';
import {
  LiveCommentPosted,
  LiveCommentRemoved,
} from '../application/events/live-events';

const HISTORY_DAYS = 30;
const minuteBucket = (ms: number) =>
  new Date(ms).toISOString().slice(0, 16).replace(/[-:T]/g, '');
export const commentPk = (streamId: string, at: number) =>
  `STREAM#${streamId}#${minuteBucket(at)}`;

/**
 * live.events → DynamoDB history (VOD replay of chat, moderation audit).
 * BatchWriteItem takes 25 puts per call; throttled leftovers come back as
 * UnprocessedItems and are retried with backoff (puts are idempotent - same
 * key, same item - so a whole-batch redelivery is harmless too).
 */
@Injectable()
export class LiveCommentsProjector implements Projector {
  readonly name = 'live-comments-history';
  // Same topic carries both event types.
  readonly topics = [LiveCommentPosted.topic];

  constructor(private readonly dynamo: DynamoService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const table = this.dynamo.table('LiveComments');
    const puts = events
      .map((e) => LiveCommentPosted.match(e))
      .filter((e): e is NonNullable<typeof e> => !!e)
      .map(({ payload: c }) => ({
        PutRequest: {
          Item: {
            PK: commentPk(c.streamId, c.at),
            SK: c.commentId,
            authorId: c.authorId,
            authorName: c.authorName,
            text: c.text,
            at: c.at,
            expiresAtEpoch: Math.floor(c.at / 1000) + HISTORY_DAYS * 86_400,
          },
        },
      }));

    for (let i = 0; i < puts.length; i += 25) {
      let request: BatchWriteCommandInput['RequestItems'] = {
        [table]: puts.slice(i, i + 25),
      };
      for (
        let attempt = 0;
        request && Object.keys(request).length > 0;
        attempt++
      ) {
        if (attempt > 6)
          throw new Error('LiveComments: unprocessed items after retries');
        if (attempt > 0) await sleep(Math.min(50 * 2 ** attempt, 2_000));
        const res = await this.dynamo.doc.send(
          new BatchWriteCommand({ RequestItems: request }),
        );
        request = res.UnprocessedItems;
      }
    }

    for (const removed of events
      .map((e) => LiveCommentRemoved.match(e))
      .filter((e): e is NonNullable<typeof e> => !!e)) {
      // Removal events carry no timestamp of the comment; the id is uuidv7 → its ms prefix IS the time.
      const at = parseInt(
        removed.payload.commentId.replace(/-/g, '').slice(0, 12),
        16,
      );
      await this.dynamo.doc
        .send(
          new UpdateCommand({
            TableName: table,
            Key: {
              PK: commentPk(removed.payload.streamId, at),
              SK: removed.payload.commentId,
            },
            UpdateExpression: 'SET removed = :t, removedReason = :r',
            ConditionExpression: 'attribute_exists(PK)',
            ExpressionAttributeValues: {
              ':t': true,
              ':r': removed.payload.reason,
            },
          }),
        )
        .catch((e: Error) => {
          if (e.name !== 'ConditionalCheckFailedException') throw e; // not persisted yet / expired: nothing to mark
        });
    }
  }
}
