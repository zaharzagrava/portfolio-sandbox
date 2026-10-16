import { Injectable } from '@nestjs/common';
import {
  BatchWriteCommand,
  type BatchWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { fullJitterBackoff, sleep } from '@app/common/core/backoff';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import type { TrackPoint, TrackStore } from '../domain/delivery-ports';

/** DynamoDB takes at most 25 puts in one `BatchWriteItem`. */
const BATCH_SIZE = 25;
const RETENTION_DAYS = 90;
/** Retries of a batch that came back with unprocessed items, then the call fails (the message is dead-lettered). */
export const TRACK_MAX_RETRIES = 6;
export const TRACK_BACKOFF = { baseMs: 50, maxMs: 2_000 };

const dayOf = (ts: number): string =>
  new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');

/**
 * `CourierTrack` (S20 FR-008, FR-011, A22): partition `COURIER#<courierId>#<yyyymmdd>`, sort key `ts`. A put with the
 * same key is the same item, so a redelivered or duplicated point is stored once (the consumer's idempotency is
 * natural); a repeated key inside one `BatchWriteItem` is refused by DynamoDB, so the batch is de-duplicated first.
 * Items expire 90 days after the point's own time. Unprocessed items are retried with exponential backoff and full
 * jitter; when the retries run out the call throws and the caller acknowledges nothing.
 */
@Injectable()
export class DynamoTrackStore implements TrackStore {
  constructor(private readonly dynamo: DynamoService) {}

  async putPoints(
    courierId: string,
    deliveryId: string | null,
    points: readonly TrackPoint[],
  ): Promise<void> {
    const table = this.dynamo.table('CourierTrack');
    const unique = [
      ...new Map(
        points.map((p) => [
          `${dayOf(p.ts)}|${p.ts}`,
          {
            PutRequest: {
              Item: {
                PK: `COURIER#${courierId}#${dayOf(p.ts)}`,
                SK: p.ts,
                lat: p.lat,
                lng: p.lng,
                ...(p.accuracy !== undefined && { accuracy: p.accuracy }),
                ...(deliveryId && { deliveryId }),
                expiresAtEpoch:
                  Math.floor(p.ts / 1000) + RETENTION_DAYS * 86_400,
              },
            },
          },
        ]),
      ).values(),
    ];
    for (let i = 0; i < unique.length; i += BATCH_SIZE) {
      let request: BatchWriteCommandInput['RequestItems'] | undefined = {
        [table]: unique.slice(i, i + BATCH_SIZE),
      };
      for (let retry = 0; request && Object.keys(request).length > 0; retry++) {
        if (retry > TRACK_MAX_RETRIES)
          throw new Error('CourierTrack: unprocessed items after retries');
        if (retry > 0) await sleep(fullJitterBackoff(retry - 1, TRACK_BACKOFF));
        request = (
          await this.dynamo.doc.send(
            new BatchWriteCommand({ RequestItems: request }),
          )
        ).UnprocessedItems;
      }
    }
  }
}
