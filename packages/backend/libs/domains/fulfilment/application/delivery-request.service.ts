import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  DeliveryShopView,
  RequestDeliveryRequest,
} from '@marketplace-sandbox/contracts';
import { CLOCK, Clock } from '@app/common/core/clock';
import { TransactionRunner } from '@app/infrastructure/context';
import {
  COURIER_REPOSITORY,
  DELIVERABLE_ORDER_STORE,
  DELIVERY_REPOSITORY,
  SURGE_STORE,
  type CourierRepository,
  type DeliverableOrderStore,
  type DeliveryRepository,
  type SurgeStore,
} from '../domain/delivery-ports';
import {
  MAX_OPEN_DELIVERIES,
  MAX_ROUTE_M,
  SURGE_CELL_PRECISION,
} from '../domain/dispatch-rules';
import {
  CityNotServedError,
  DeliveryAlreadyCompletedError,
  DeliveryAlreadyOpenError,
  OpenDeliveryLimitError,
  OrderNotDeliverableError,
  OrderNotFoundForDeliveryError,
  RouteTooLongError,
} from '../domain/delivery-errors';
import { toShopView } from '../domain/delivery-views';
import { distanceM, geohash } from '../domain/geohash';
import {
  feeForSurge,
  isSurgeStep,
  SURGE_MIN,
  surgeToMultiplier,
} from '../domain/surge-fee';
import { afterCommit } from './after-commit';
import { logDelivery } from './delivery-log';
import { DispatchService } from './dispatch.service';

/**
 * The shop's request for a delivery (S20 FR-029..FR-035). The order comes from the fulfilment-owned copy of `order.paid`
 * (the buyer and currency are never the caller's); route, served city and the shop's open-delivery count are checked,
 * the fee is fixed from the surge of the pickup cell, and the delivery, its creation history row and its outbox event
 * are written in ONE transaction under the shop's advisory lock (so the 200 limit holds under a race, and the unique
 * partial index decides two requests for one order). The first dispatch runs after the commit and before the answer;
 * a fault there leaves a `REQUESTED` delivery that the recovery job offers. Idempotency of the HTTP call is the
 * platform's `@Idempotent` on the route.
 */
@Injectable()
export class DeliveryRequestService {
  private readonly logger = new Logger(DeliveryRequestService.name);

  constructor(
    @Inject(DELIVERY_REPOSITORY)
    private readonly deliveries: DeliveryRepository,
    @Inject(DELIVERABLE_ORDER_STORE)
    private readonly orders: DeliverableOrderStore,
    @Inject(COURIER_REPOSITORY) private readonly couriers: CourierRepository,
    @Inject(SURGE_STORE) private readonly surges: SurgeStore,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly runner: TransactionRunner,
    private readonly dispatch: DispatchService,
  ) {}

  async request(
    shopId: string,
    input: RequestDeliveryRequest,
  ): Promise<DeliveryShopView> {
    const order = await this.orders.find(input.orderId);
    // Not paid (no copy), foreign and unknown orders are the same answer: existence is not revealed (V.4). A copy
    // created by a cancel that arrived before the payment knows no shops (AS-56): it answers `order_not_deliverable`.
    const shopsUnknown =
      order?.status === 'CANCELLED' && order.shopIds.length === 0;
    if (!order || !(shopsUnknown || order.shopIds.includes(shopId)))
      throw new OrderNotFoundForDeliveryError();
    const currency = order.currency;
    if (order.status !== 'PAID' || !currency)
      throw new OrderNotDeliverableError();

    if (
      distanceM(
        input.pickup.lat,
        input.pickup.lng,
        input.dropoff.lat,
        input.dropoff.lng,
      ) > MAX_ROUTE_M
    )
      throw new RouteTooLongError();
    if (!(await this.couriers.isCityServed(input.city)))
      throw new CityNotServedError();

    const cell = geohash(
      input.pickup.lat,
      input.pickup.lng,
      SURGE_CELL_PRECISION,
    );
    const stored = await this.surges.read(input.city, cell);
    const surge = stored !== null && isSurgeStep(stored) ? stored : SURGE_MIN;
    const now = this.clock.now();

    const created = await this.runner.run(async () => {
      const open = await this.deliveries.lockShopAndCountOpen(shopId);
      if (open >= MAX_OPEN_DELIVERIES) throw new OpenDeliveryLimitError();
      return this.deliveries.insertRequested(
        {
          shopId,
          orderId: order.orderId,
          buyerId: order.buyerId,
          city: input.city,
          pickup: input.pickup,
          dropoff: input.dropoff,
          feeMinor: feeForSurge(surge),
          currency,
          surge: surgeToMultiplier(surge),
        },
        now,
      );
    });
    if (created.outcome === 'already_open')
      throw new DeliveryAlreadyOpenError();
    if (created.outcome === 'already_completed')
      throw new DeliveryAlreadyCompletedError();
    const id = created.delivery.id;

    logDelivery(this.logger, 'log', 'delivery.requested', {
      deliveryId: id,
      shopId,
      city: input.city,
    });
    await afterCommit(
      this.logger,
      'request',
      [
        () => this.surges.recordDemand(input.city, cell, now.getTime()),
        () => this.dispatch.dispatch(id, now),
      ],
      { deliveryId: id, city: input.city },
    );

    const current = (await this.deliveries.findById(id)) ?? created.delivery;
    return toShopView(current);
  }
}
