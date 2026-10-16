import { Inject, Injectable } from '@nestjs/common';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CLOCK, Clock } from '@app/common/core/clock';
import { sleep } from '@app/common/core/backoff';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { TransientError } from '@app/infrastructure/projections/errors';
import {
  LiveCommentPosted,
  LiveCommentRemoved,
} from '../application/events/live-events';
import { liveMetrics } from '../application/live-metrics';
import {
  HISTORY_DAYS,
  HISTORY_GROUP,
  HISTORY_RETRIES,
  LIVE_CONSUMER_HISTORY,
} from '../domain/live-constants';
import { commentPk, commentTimeMs } from '../domain/live-history-keys';

export { commentPk } from '../domain/live-history-keys';

const THROTTLED = new Set([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'TooManyRequestsException',
]);

type Operation =
  | {
      kind: 'posted';
      event: NonNullable<ReturnType<typeof LiveCommentPosted.match>>;
    }
  | {
      kind: 'removed';
      event: NonNullable<ReturnType<typeof LiveCommentRemoved.match>>;
    };

/**
 * `live.events` → DynamoDB history (VOD replay of chat, moderation audit). Posts and removals are both `UpdateItem`
 * upserts of the same item (key: stream + minute of the comment, comment id), so they commute: a removal that arrives
 * first leaves a marker the post then fills in, and a repeat changes nothing (FR-038). The events are written in
 * groups of at most 25; a throttled write is retried with growing waits, and when the retries run out the delivery
 * fails and is redelivered by the framework, never dropped (FR-037).
 */
@Injectable()
export class LiveCommentsProjector implements Projector {
  readonly name = LIVE_CONSUMER_HISTORY;
  readonly topics = [LiveCommentPosted.topic];
  // Upserts are keyed by comment id: applying them twice changes nothing.
  readonly idempotency = 'natural' as const;
  readonly handles = [
    { event: LiveCommentPosted },
    { event: LiveCommentRemoved },
  ];

  constructor(
    private readonly dynamo: DynamoService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const operations: Operation[] = [];
    for (const envelope of events) {
      const posted = LiveCommentPosted.match(envelope);
      if (posted) operations.push({ kind: 'posted', event: posted });
      const removed = LiveCommentRemoved.match(envelope);
      if (removed) operations.push({ kind: 'removed', event: removed });
    }
    for (let i = 0; i < operations.length; i += HISTORY_GROUP) {
      const group = operations.slice(i, i + HISTORY_GROUP);
      try {
        await Promise.all(group.map((op) => this.write(op)));
      } catch (error) {
        liveMetrics.consumerFailures.add(1, { consumer: this.name });
        throw error;
      }
    }
  }

  private async write(op: Operation): Promise<void> {
    const command = this.command(op);
    for (let attempt = 0; ; attempt++) {
      try {
        await this.dynamo.doc.send(command);
        return;
      } catch (error) {
        if (!THROTTLED.has((error as Error).name)) throw error;
        if (attempt >= HISTORY_RETRIES)
          throw new TransientError('LiveComments: throttled after retries', {
            cause: error,
          });
        await sleep(Math.min(25 * 2 ** attempt, 1_000));
      }
    }
  }

  private command(op: Operation): UpdateCommand {
    const table = this.dynamo.table('LiveComments');
    if (op.kind === 'posted') {
      const c = op.event.payload;
      liveMetrics.historyLag.record(
        Math.max(0, this.clock.nowMs() - c.at) / 1000,
      );
      return new UpdateCommand({
        TableName: table,
        Key: { PK: commentPk(c.streamId, c.at), SK: c.commentId },
        UpdateExpression:
          'SET authorId = :a, authorName = :n, #text = :t, #at = :at, expiresAtEpoch = :e' +
          (c.priority ? ', priority = :p' : ''),
        ExpressionAttributeNames: { '#text': 'text', '#at': 'at' },
        ExpressionAttributeValues: {
          ':a': c.authorId,
          ':n': c.authorName,
          ':t': c.text,
          ':at': c.at,
          ':e': Math.floor(c.at / 1000) + HISTORY_DAYS * 86_400,
          ...(c.priority && { ':p': true }),
        },
      });
    }
    const r = op.event.payload;
    // A removal carries no post time; the comment id is uuidv7, so its millisecond prefix IS the time and finds the item.
    const at = commentTimeMs(r.commentId);
    return new UpdateCommand({
      TableName: table,
      Key: { PK: commentPk(r.streamId, at), SK: r.commentId },
      UpdateExpression:
        'SET removed = :t, removedReason = :r, expiresAtEpoch = if_not_exists(expiresAtEpoch, :e)',
      ExpressionAttributeValues: {
        ':t': true,
        ':r': r.reason,
        ':e': Math.floor(at / 1000) + HISTORY_DAYS * 86_400,
      },
    });
  }
}
