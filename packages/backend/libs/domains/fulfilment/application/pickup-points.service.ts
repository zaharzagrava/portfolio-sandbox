import { Inject, Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import {
  PICKUP_LIMITS,
  type PickupPoint,
  type PickupPointCreate,
  type PickupPointPage,
  type PickupPointPatch,
  type PickupListQuery,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import { OutboxService } from '@app/infrastructure/outbox/outbox.service';
import { validateOpeningHours } from '../domain/opening-hours';
import {
  PICKUP_POINT_REPOSITORY,
  type PickupPointChanges,
  type PickupPointRecord,
  type PickupPointRepository,
} from '../domain/pickup-ports';
import {
  PickupPointLimitReachedError,
  PickupPointNotFoundError,
  PickupValidationError,
} from '../domain/pickup-errors';
import { decodeCursor, encodeCursor, queryKey } from '../domain/search-cursor';
import { PickupPointChanged } from './events/pickup-events';
import { guardWrite } from './pickup-guard';

export const toPointView = (p: PickupPointRecord): PickupPoint => ({
  id: p.id,
  shopId: p.shopId,
  name: p.name,
  address: p.address,
  lat: p.lat,
  lng: p.lng,
  openingHours: p.openingHours,
  active: p.active,
  version: p.version,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString(),
});

export const pointChangedEvent = (p: PickupPointRecord) =>
  PickupPointChanged.create(p.id, p.version, {
    pickupPointId: p.id,
    shopId: p.shopId,
    name: p.name,
    address: p.address,
    lat: p.lat,
    lng: p.lng,
    active: p.active,
    pointVersion: p.version,
  });

/**
 * Seller use cases for pickup points (S19 FR-001..FR-006). No SQL: the repository port does it. Each write is one
 * transaction holding the row change and its event (FR-016).
 */
@Injectable()
export class PickupPointsService {
  constructor(
    @Inject(PICKUP_POINT_REPOSITORY)
    private readonly points: PickupPointRepository,
    private readonly tx: TransactionRunner,
    private readonly outbox: OutboxService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  create(shopId: string, body: PickupPointCreate): Promise<PickupPoint> {
    const hours = validateOpeningHours(body.openingHours ?? {});
    if (!hours.ok) throw new PickupValidationError([hours.field]);
    return guardWrite(() =>
      this.tx.run(async () => {
        if (
          (await this.points.lockAndCount(shopId)) >=
          PICKUP_LIMITS.pointsPerShop
        )
          throw new PickupPointLimitReachedError();
        const point = await this.points.insert(
          shopId,
          {
            name: body.name,
            address: body.address,
            lat: body.lat,
            lng: body.lng,
            openingHours: hours.value,
          },
          this.clock.now(),
        );
        await this.outbox.append(pointChangedEvent(point));
        return toPointView(point);
      }),
    );
  }

  update(
    shopId: string,
    pointId: string,
    patch: PickupPointPatch,
  ): Promise<PickupPoint> {
    let openingHours = patch.openingHours;
    if (openingHours !== undefined) {
      const hours = validateOpeningHours(openingHours);
      if (!hours.ok) throw new PickupValidationError([hours.field]);
      openingHours = hours.value;
    }
    return guardWrite(() =>
      this.tx.run(async () => {
        const current = await this.points.findInShop(shopId, pointId, {
          forUpdate: true,
        });
        if (!current) throw new PickupPointNotFoundError();
        const changes: PickupPointChanges = {};
        if (patch.name !== undefined && patch.name !== current.name)
          changes.name = patch.name;
        if (patch.address !== undefined && patch.address !== current.address)
          changes.address = patch.address;
        if (patch.active !== undefined && patch.active !== current.active)
          changes.active = patch.active;
        if (
          openingHours !== undefined &&
          !isDeepStrictEqual(openingHours, current.openingHours)
        )
          changes.openingHours = openingHours;
        // a change that alters nothing: no version, no event
        if (Object.keys(changes).length === 0) return toPointView(current);
        const updated = await this.points.update(
          shopId,
          pointId,
          changes,
          this.clock.now(),
        );
        await this.outbox.append(pointChangedEvent(updated));
        return toPointView(updated);
      }),
    );
  }

  async list(shopId: string, query: PickupListQuery): Promise<PickupPointPage> {
    const key = queryKey({ shopId, list: 'points' });
    let after: [string, string] | null = null;
    if (query.cursor) {
      const tuple = decodeCursor(query.cursor, key);
      if (
        !tuple ||
        typeof tuple[0] !== 'string' ||
        typeof tuple[1] !== 'string'
      )
        throw new PickupValidationError(['cursor']);
      after = [tuple[0], tuple[1]];
    }
    const rows = await this.points.listPage(shopId, query.limit + 1, after);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page.map(toPointView),
      nextCursor:
        rows.length > query.limit && last
          ? encodeCursor([last.createdAt.toISOString(), last.id], key)
          : null,
    };
  }
}
