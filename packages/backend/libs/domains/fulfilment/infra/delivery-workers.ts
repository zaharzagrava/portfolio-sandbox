import {
  Injectable,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import {
  BatchWriteCommand,
  BatchWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import { TaskQueue } from '@app/infrastructure/sqs/task-queue.port';
import { DynamoService } from '@app/infrastructure/dynamo/dynamo.service';
import { JobHandler } from '@app/infrastructure/jobs/job-handler.decorator';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { Projector } from '@app/infrastructure/projections/projector';
import { sleep } from '@app/common/core/backoff';
import {
  DispatchService,
  OFFER_TIMEOUT_QUEUE,
  OfferTimeout,
} from '../application/dispatch.service';
import { CourierLocationsReported } from '../application/events/courier-events';
import { demandKey, geoKey, surgeKey } from './courier-keys';

declare module '@app/infrastructure/jobs/job-types' {
  interface JobPayloads {
    'delivery.compute-surge': Record<string, never>;
  }
}

export const CITIES_KEY = 'delivery:cities';
const TRACK_TTL_DAYS = 90;

/** apps/worker: offer expiry / dispatch retries from the SQS delay queue. */
@Injectable()
export class OfferTimeoutWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private stop?: () => Promise<void>;

  constructor(
    private readonly queue: TaskQueue,
    private readonly dispatch: DispatchService,
  ) {}

  onApplicationBootstrap() {
    this.stop = this.queue.consume<OfferTimeout>(
      OFFER_TIMEOUT_QUEUE,
      ({ body }) => this.dispatch.onOfferTimeout(body),
      { concurrency: 50 },
    );
  }

  async onModuleDestroy() {
    await this.stop?.();
  }
}

/** apps/projector: courier location batches → DynamoDB `CourierTrack` (BatchWrite 25, retries UnprocessedItems). */
@Injectable()
export class CourierTrackProjector implements Projector {
  readonly name = 'courier-track';
  readonly topics = [CourierLocationsReported.topic];

  constructor(private readonly dynamo: DynamoService) {}

  async project(events: EventEnvelope[]): Promise<void> {
    const table = this.dynamo.table('CourierTrack');
    const puts = events
      .map((e) => CourierLocationsReported.match(e))
      .filter((e): e is NonNullable<typeof e> => !!e)
      .flatMap(({ payload: b }) =>
        b.points.map((p) => ({
          PutRequest: {
            Item: {
              PK: `COURIER#${b.courierId}#${new Date(p.ts).toISOString().slice(0, 10).replace(/-/g, '')}`,
              SK: p.ts,
              lat: p.lat,
              lng: p.lng,
              ...(p.accuracy !== undefined && { accuracy: p.accuracy }),
              ...(b.deliveryId && { deliveryId: b.deliveryId }),
              expiresAtEpoch: Math.floor(p.ts / 1000) + TRACK_TTL_DAYS * 86_400,
            },
          },
        })),
      );
    // Same key twice in one BatchWrite is rejected by DynamoDB - dedupe (redelivered batches).
    const unique = [
      ...new Map(
        puts.map((p) => [`${p.PutRequest.Item.PK}|${p.PutRequest.Item.SK}`, p]),
      ).values(),
    ];
    for (let i = 0; i < unique.length; i += 25) {
      let request: BatchWriteCommandInput['RequestItems'] = {
        [table]: unique.slice(i, i + 25),
      };
      for (
        let attempt = 0;
        request && Object.keys(request).length > 0;
        attempt++
      ) {
        if (attempt > 6)
          throw new Error('CourierTrack: unprocessed items after retries');
        if (attempt > 0) await sleep(Math.min(50 * 2 ** attempt, 2_000));
        request = (
          await this.dynamo.doc.send(
            new BatchWriteCommand({ RequestItems: request }),
          )
        ).UnprocessedItems;
      }
    }
  }
}

/**
 * apps/worker, every minute: surge per geohash-5 cell (~5 km) per city =
 * demand (requests in the last 10 min) / supply (available couriers now),
 * clamped to [1.0, 3.0] in 0.25 steps. Read at request time to price the fee.
 */
@Injectable()
export class SurgeJob implements OnApplicationBootstrap {
  constructor(
    private readonly redis: RedisService,
    private readonly jobs: JobsService,
  ) {}

  async onApplicationBootstrap() {
    await this.jobs.upsertSchedule({
      name: 'delivery.compute-surge',
      cron: '* * * * *',
      jobType: 'delivery.compute-surge',
      payload: {},
    });
  }

  @JobHandler('delivery.compute-surge', { concurrency: 1 })
  async run(): Promise<number> {
    let cells = 0;
    for (const city of await this.redis.client.smembers(CITIES_KEY))
      cells += Object.keys(await this.compute(city)).length;
    return cells;
  }

  async compute(
    city: string,
    now = Date.now(),
  ): Promise<Record<string, number>> {
    const supply = new Map<string, number>();
    const members = await this.redis.client.zrange(geoKey(city), 0, -1);
    for (let i = 0; i < members.length; i += 1_000) {
      const hashes = await this.redis.client.geohash(
        geoKey(city),
        ...members.slice(i, i + 1_000),
      );
      for (const h of hashes)
        if (h) supply.set(h.slice(0, 5), (supply.get(h.slice(0, 5)) ?? 0) + 1);
    }
    const demand = new Map<string, number>();
    const minute = Math.floor(now / 60_000);
    const pipeline = this.redis.client.pipeline();
    for (let m = minute - 9; m <= minute; m++)
      pipeline.hgetall(demandKey(city, m));
    for (const [, counts] of (await pipeline.exec()) ?? [])
      for (const [cell, n] of Object.entries(
        (counts ?? {}) as Record<string, string>,
      ))
        demand.set(cell, (demand.get(cell) ?? 0) + Number(n));

    const surge: Record<string, number> = {};
    for (const [cell, requests] of demand) {
      const ratio = requests / Math.max(supply.get(cell) ?? 0, 1);
      const value = Math.min(3, Math.max(1, Math.round(ratio * 4) / 4));
      if (value > 1) surge[cell] = value;
    }
    const multi = this.redis.client.multi().del(surgeKey(city));
    if (Object.keys(surge).length)
      multi.hset(surgeKey(city), surge).expire(surgeKey(city), 180);
    await multi.exec();
    return surge;
  }
}
