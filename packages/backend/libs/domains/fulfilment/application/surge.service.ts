import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  COURIER_REPOSITORY,
  GEO_INDEX,
  SURGE_STORE,
  type CourierRepository,
  type GeoIndex,
  type SurgeStore,
} from '../domain/delivery-ports';
import { POSITION_MAX_AGE_MS } from '../domain/courier-eligibility';
import {
  SURGE_CELL_PRECISION,
  SURGE_TTL_SECONDS,
} from '../domain/dispatch-rules';
import { surgeFromRatio } from '../domain/surge-fee';
import { cityLabel, DeliveryMetrics } from './delivery-metrics';
import { errorText, logDelivery } from './delivery-log';
import { DeliveryOwnership } from './delivery-ownership.service';

/**
 * Surge per geohash cell (S20 FR-042, A24), computed once a minute: demand (requests of the last 10 minutes, counted at
 * request time) over the eligible supply of the cell (searchable couriers with a position at most 60 s old), rounded to
 * quarter steps and clamped to 1.00..3.00. A cell at ratio 1 or below has no entry. Cities come from the `Courier` rows,
 * only the cities `ownedCities` lists are computed (`null` = all), each city reads only its own keys and one city's
 * failure never stops another. The map of a city is replaced as a whole with a 180 s expiry, so a stopped computation
 * falls back to 1.00 by itself. `now` comes from the caller (`CLOCK`).
 */
@Injectable()
export class SurgeService {
  private readonly logger = new Logger(SurgeService.name);

  constructor(
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(GEO_INDEX) private readonly geo: GeoIndex,
    @Inject(SURGE_STORE) private readonly surges: SurgeStore,
    private readonly ownership: DeliveryOwnership,
  ) {}

  /**
   * Computes the cities this instance owns (or `ownedCities` when given: `null` = every city, a list = those) and
   * returns the written map of each city that succeeded, in hundredths.
   */
  async compute(
    now: Date,
    ownedCities?: readonly string[] | null,
  ): Promise<Map<string, Map<string, number>>> {
    const cities = await this.couriers.listCities();
    const mine =
      ownedCities === undefined
        ? await this.ownership.ownedCities(cities)
        : ownedCities;
    const result = new Map<string, Map<string, number>>();
    for (const city of cities) {
      if (mine && !mine.includes(city)) continue;
      try {
        result.set(city, await this.computeCity(city, now));
      } catch (error) {
        DeliveryMetrics.dispatchFailures.add(1, { city: cityLabel(city) });
        logDelivery(this.logger, 'error', 'surge.compute_failed', {
          city,
          error: errorText(error),
        });
      }
    }
    return result;
  }

  private async computeCity(
    city: string,
    now: Date,
  ): Promise<Map<string, number>> {
    const nowMs = now.getTime();
    const demand = await this.surges.demandByCell(city, nowMs);
    const supply =
      demand.size === 0
        ? new Map<string, number>()
        : await this.geo.searchableByCell(
            city,
            SURGE_CELL_PRECISION,
            nowMs - POSITION_MAX_AGE_MS,
          );
    const map = new Map<string, number>();
    for (const [cell, requests] of demand) {
      const surge = surgeFromRatio(requests, supply.get(cell) ?? 0);
      if (surge !== null) map.set(cell, surge);
    }
    await this.surges.write(city, map, SURGE_TTL_SECONDS);
    return map;
  }
}
