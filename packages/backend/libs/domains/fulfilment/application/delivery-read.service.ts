import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  DeliveryBuyerList,
  DeliveryBuyerView,
  DeliveryCourierView,
  DeliveryPage,
  DeliveryShopView,
  DeliveryStatusValue,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import {
  COURIER_REPOSITORY,
  DELIVERY_REPOSITORY,
  GEO_INDEX,
  type CourierRepository,
  type DeliveryRecord,
  type DeliveryRepository,
  type GeoIndex,
  type LivePosition,
} from '../domain/delivery-ports';
import {
  DeliveryNotFoundError,
  DeliveryValidationError,
} from '../domain/delivery-errors';
import {
  toBuyerView,
  toCourierView,
  toShopView,
} from '../domain/delivery-views';
import { decodeCursor, encodeCursor, queryKey } from '../domain/search-cursor';
import { errorText, logDelivery } from './delivery-log';

export interface ShopListInput {
  status?: DeliveryStatusValue;
  limit: number;
  cursor?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Reads of deliveries (S20 FR-036..FR-039, A3, A4). The principal is in every predicate and a row that is not the
 * caller's is `404 delivery_not_found`, the same as one that does not exist (V.4): the buyer, the assigned courier and
 * the courier holding the live offer each get their own view; the shop reads by `(shopId, id)`. Views are the explicit
 * allowlists of `delivery-views.ts`. The buyer's courier position comes from the live index, only while the delivery is
 * on its way; an index fault shows no position, never an error.
 */
@Injectable()
export class DeliveryReadService {
  private readonly logger = new Logger(DeliveryReadService.name);

  constructor(
    @Inject(DELIVERY_REPOSITORY)
    private readonly deliveries: DeliveryRepository,
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(GEO_INDEX) private readonly geo: GeoIndex,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** `GET /deliveries/:id`: the buyer's view, else the courier's view, else `404`. */
  async forCaller(
    id: string,
    userId: string,
  ): Promise<DeliveryBuyerView | DeliveryCourierView> {
    const now = this.clock.now();
    const asBuyer = await this.deliveries.findForBuyer(id, userId);
    if (asBuyer) return this.buyerView(asBuyer, now);
    const asCourier = await this.deliveries.findForCourier(id, userId, now);
    if (asCourier)
      return toCourierView(
        asCourier.delivery,
        asCourier.offer?.expiresAt ?? null,
      );
    throw new DeliveryNotFoundError();
  }

  /** `GET /orders/:orderId/deliveries`: the buyer's own deliveries for the order (another buyer: empty). */
  async forBuyerByOrder(
    orderId: string,
    buyerId: string,
  ): Promise<DeliveryBuyerList> {
    const now = this.clock.now();
    const rows = await this.deliveries.listForBuyerByOrder(orderId, buyerId);
    return {
      items: await Promise.all(rows.map((row) => this.buyerView(row, now))),
    };
  }

  /** `GET /shops/:shopId/deliveries`: keyset pages, newest first, then by id descending. */
  async listForShop(
    shopId: string,
    input: ShopListInput,
  ): Promise<DeliveryPage> {
    const key = queryKey({ shopId, status: input.status ?? null });
    const after = input.cursor ? this.readCursor(input.cursor, key) : undefined;
    const rows = await this.deliveries.listForShop(shopId, {
      status: input.status,
      limit: input.limit + 1,
      after,
    });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => toShopView(row)),
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor([last.createdAt.toISOString(), last.id], key)
          : null,
    };
  }

  /** `GET /shops/:shopId/deliveries/:id`: the shop view with the transition history. */
  async shopDetail(shopId: string, id: string): Promise<DeliveryShopView> {
    const row = await this.deliveries.findForShop(shopId, id);
    if (!row) throw new DeliveryNotFoundError();
    return toShopView(row, await this.deliveries.history(id));
  }

  private readCursor(
    cursor: string,
    key: string,
  ): { createdAt: Date; id: string } {
    const tuple = decodeCursor(cursor, key);
    const [at, id] = tuple ?? [];
    const createdAt = typeof at === 'string' ? new Date(at) : null;
    if (
      tuple?.length !== 2 ||
      !createdAt ||
      Number.isNaN(createdAt.getTime()) ||
      typeof id !== 'string' ||
      !UUID.test(id)
    )
      throw new DeliveryValidationError(['cursor']);
    return { createdAt, id };
  }

  private async buyerView(
    row: DeliveryRecord,
    now: Date,
  ): Promise<DeliveryBuyerView> {
    const profile = row.courierId
      ? await this.couriers.find(row.courierId)
      : null;
    const onTheWay = row.status === 'ASSIGNED' || row.status === 'PICKED_UP';
    const position =
      profile && row.courierId && onTheWay
        ? await this.position(row.city, row.courierId)
        : null;
    return toBuyerView(
      row,
      profile ? { vehicle: profile.vehicle, position } : null,
      now.getTime(),
    );
  }

  private async position(
    city: string,
    courierId: string,
  ): Promise<LivePosition | null> {
    try {
      return await this.geo.position(city, courierId);
    } catch (error) {
      logDelivery(this.logger, 'warn', 'delivery.position_unavailable', {
        courierId,
        city,
        error: errorText(error),
      });
      return null;
    }
  }
}
