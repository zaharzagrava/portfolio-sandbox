import { Injectable } from '@nestjs/common';
import type { CourierStatus, GeoPoint } from '@marketplace-sandbox/contracts';
import { RedisService } from '@app/infrastructure/redis/redis.service';
import type { GeoHit, GeoIndex, LivePosition } from '../domain/delivery-ports';
import { APPLY_LOCATION, courierKey, geoKey, SET_STATUS } from './courier-keys';

/** Every Redis call of this adapter gives up after this long: a slow store must not hold a request open (A26, R-9). */
export const GEO_COMMAND_TIMEOUT_MS = 1_000;
/** The live position hash lives this long after the last accepted point. */
const POSITION_TTL_SECONDS = 300;

class GeoTimeoutError extends Error {
  constructor() {
    super(`live index command timed out after ${GEO_COMMAND_TIMEOUT_MS} ms`);
    this.name = 'GeoTimeoutError';
  }
}

const withTimeout = <T>(work: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new GeoTimeoutError()),
        GEO_COMMAND_TIMEOUT_MS,
      );
    }),
  ]).finally(() => clearTimeout(timer));
};

/**
 * The per-city live index in Redis (S20 D-6, A11): one hash per courier with the newest accepted point and one GEO set
 * of searchable couriers per city. Every key carries the `{city}` hash tag, so a city's keys share one slot and the Lua
 * scripts touch them atomically (cell isolation, AS-54). Everything here is derived state: a lost key is repaired by the
 * next ping. Freshness of a position is judged by the caller from `positionTs`, never by a TTL in here.
 */
@Injectable()
export class RedisGeoIndex implements GeoIndex {
  constructor(private readonly redis: RedisService) {}

  async applyLocation(input: {
    city: string;
    courierId: string;
    lat: number;
    lng: number;
    ts: number;
    searchable: boolean;
  }): Promise<{ applied: boolean; deliveryId: string | null }> {
    const [applied, deliveryId] = (await withTimeout(
      this.redis.client.eval(
        APPLY_LOCATION,
        2,
        courierKey(input.city, input.courierId),
        geoKey(input.city),
        input.courierId,
        input.ts,
        input.lat,
        input.lng,
        POSITION_TTL_SECONDS,
        input.searchable ? '1' : '0',
      ),
    )) as [number, string];
    return { applied: applied === 1, deliveryId: deliveryId || null };
  }

  async setStatus(
    city: string,
    courierId: string,
    status: CourierStatus,
    deliveryId: string | null,
  ): Promise<void> {
    await withTimeout(
      this.redis.client.eval(
        SET_STATUS,
        2,
        courierKey(city, courierId),
        geoKey(city),
        courierId,
        status,
        deliveryId ?? '',
      ),
    );
  }

  async removeSearchable(city: string, courierId: string): Promise<void> {
    await withTimeout(this.redis.client.zrem(geoKey(city), courierId));
  }

  async search(
    city: string,
    center: GeoPoint,
    radiusM: number,
    limit: number,
  ): Promise<GeoHit[]> {
    const found = (await withTimeout(
      this.redis.client.geosearch(
        geoKey(city),
        'FROMLONLAT',
        center.lng,
        center.lat,
        'BYRADIUS',
        radiusM,
        'm',
        'ASC',
        'COUNT',
        limit,
        'WITHDIST',
      ),
    )) as [string, string][];
    if (found.length === 0) return [];
    const stamps = await withTimeout(
      Promise.all(
        found.map(([id]) => this.redis.client.hget(courierKey(city, id), 'ts')),
      ),
    );
    return found.map(([courierId, distance], i) => ({
      courierId,
      distanceM: Number(distance),
      positionTs: Number(stamps[i] ?? 0),
    }));
  }

  async position(
    city: string,
    courierId: string,
  ): Promise<LivePosition | null> {
    const [lat, lng, ts] = await withTimeout(
      this.redis.client.hmget(courierKey(city, courierId), 'lat', 'lng', 'ts'),
    );
    return lat && lng && ts
      ? { lat: Number(lat), lng: Number(lng), ts: Number(ts) }
      : null;
  }

  async searchableByCell(
    city: string,
    precision: number,
    freshSince: number,
  ): Promise<Map<string, number>> {
    const cells = new Map<string, number>();
    const members = await withTimeout(
      this.redis.client.zrange(geoKey(city), 0, -1),
    );
    for (let i = 0; i < members.length; i += 1_000) {
      const chunk = members.slice(i, i + 1_000);
      const [hashes, stamps] = await withTimeout(
        Promise.all([
          this.redis.client.geohash(geoKey(city), ...chunk),
          Promise.all(
            chunk.map((id) =>
              this.redis.client.hget(courierKey(city, id), 'ts'),
            ),
          ),
        ]),
      );
      hashes.forEach((hash, j) => {
        if (!hash || Number(stamps[j] ?? 0) < freshSince) return;
        const cell = hash.slice(0, precision);
        cells.set(cell, (cells.get(cell) ?? 0) + 1);
      });
    }
    return cells;
  }

  async pruneStale(city: string, staleBefore: number): Promise<number> {
    const members = await withTimeout(
      this.redis.client.zrange(geoKey(city), 0, -1),
    );
    let removed = 0;
    for (let i = 0; i < members.length; i += 1_000) {
      const chunk = members.slice(i, i + 1_000);
      const stamps = await withTimeout(
        Promise.all(
          chunk.map((id) => this.redis.client.hget(courierKey(city, id), 'ts')),
        ),
      );
      const stale = chunk.filter(
        (_, j) => Number(stamps[j] ?? 0) < staleBefore,
      );
      if (stale.length > 0)
        removed += await withTimeout(
          this.redis.client.zrem(geoKey(city), ...stale),
        );
    }
    return removed;
  }
}
