import { Inject, Injectable, Logger } from '@nestjs/common';
import { CLOCK, Clock } from '@app/common/core/clock';
import { JobsService } from '@app/infrastructure/jobs/jobs.service';
import { NonRetryableJobError } from '@app/infrastructure/jobs/job-types';
import {
  DELIVERABLE_ORDER_STORE,
  DELIVERY_REPOSITORY,
  ORDER_LIFECYCLE_PORT,
  type DeliverableOrderStore,
  type DeliveryRecord,
  type DeliveryRepository,
  type OrderCommand,
  type OrderLifecyclePort,
} from '../domain/delivery-ports';
import {
  ORDER_LIFECYCLE_JOB,
  WRITE_BACK_STEPS,
  orderLifecycleJobKey,
  type WriteBackStep,
} from '../domain/dispatch-rules';
import { DeliveryMetrics } from './delivery-metrics';
import { errorText, logDelivery } from './delivery-log';

const STEP_RANK: Record<WriteBackStep, number> = {
  ASSIGNED: 1,
  PICKED_UP: 2,
  DELIVERED: 3,
};

export const isWriteBackStep = (status: string): status is WriteBackStep =>
  (WRITE_BACK_STEPS as readonly string[]).includes(status);

/** What the order service is told for each milestone (FR-046): `ship` carries the delivery id as tracking code. */
export const commandFor = (
  step: WriteBackStep,
  deliveryId: string,
): OrderCommand => {
  switch (step) {
    case 'ASSIGNED':
      return { type: 'startFulfilment' };
    case 'PICKED_UP':
      return { type: 'ship', trackingCode: deliveryId };
    case 'DELIVERED':
      return { type: 'deliver' };
  }
};

/**
 * Queues the write-back after a transition has committed (S20 FR-046, R-10). One job per `(delivery, milestone)`: the
 * idempotency key makes a second enqueue (a replay, the recovery re-drive) find the first. A failure to enqueue is
 * logged: the recovery job finds the delivery by `orderSyncedStatus` and tries again.
 */
@Injectable()
export class OrderWriteBackScheduler {
  private readonly logger = new Logger(OrderWriteBackScheduler.name);

  constructor(private readonly jobs: JobsService) {}

  async schedule(
    delivery: Pick<DeliveryRecord, 'id' | 'status'>,
  ): Promise<void> {
    if (!isWriteBackStep(delivery.status)) return;
    try {
      await this.jobs.enqueue(
        ORDER_LIFECYCLE_JOB,
        { deliveryId: delivery.id, status: delivery.status },
        { idempotencyKey: orderLifecycleJobKey(delivery.id, delivery.status) },
      );
    } catch (error) {
      logDelivery(this.logger, 'error', 'delivery.write_back_not_queued', {
        deliveryId: delivery.id,
        status: delivery.status,
        error: errorText(error),
      });
    }
  }
}

/**
 * The job body of `fulfilment.apply-order-lifecycle` (S20 FR-046, AS-36): tells the order every milestone it has not
 * been told yet, up to the job's status, in order. A transient failure throws and the job framework retries with
 * backoff (the delivery is untouched); `orderSyncedStatus` moves only after the order accepted a step, so a retry never
 * repeats a step that worked. Only single-shop orders are written to (fulfilment per shop is out of scope in S10).
 */
@Injectable()
export class OrderLifecycleService {
  private readonly logger = new Logger(OrderLifecycleService.name);

  constructor(
    @Inject(DELIVERY_REPOSITORY)
    private readonly deliveries: DeliveryRepository,
    @Inject(DELIVERABLE_ORDER_STORE)
    private readonly orders: DeliverableOrderStore,
    @Inject(ORDER_LIFECYCLE_PORT) private readonly port: OrderLifecyclePort,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async apply(deliveryId: string, upTo: WriteBackStep): Promise<void> {
    const delivery = await this.deliveries.findById(deliveryId);
    if (!delivery) throw new NonRetryableJobError('delivery_not_found');
    // A delivery cancelled before the order was told must not start the order's fulfilment.
    if (delivery.status === 'CANCELLED') return;

    const order = await this.orders.find(delivery.orderId);
    if (!order) {
      DeliveryMetrics.orderWriteBack.add(1, { result: 'dead_lettered' });
      throw new NonRetryableJobError('order_copy_missing');
    }
    if (order.shopIds.length !== 1) {
      DeliveryMetrics.orderWriteBack.add(1, { result: 'skipped_multi_shop' });
      return;
    }

    const synced = delivery.orderSyncedStatus;
    const syncedRank =
      synced && isWriteBackStep(synced) ? STEP_RANK[synced] : 0;
    for (const step of WRITE_BACK_STEPS) {
      if (STEP_RANK[step] <= syncedRank || STEP_RANK[step] > STEP_RANK[upTo])
        continue;
      const outcome = await this.port.apply(
        delivery.orderId,
        commandFor(step, delivery.id),
      );
      switch (outcome) {
        case 'applied':
          DeliveryMetrics.orderWriteBack.add(1, { result: 'applied' });
          break;
        case 'already_reached':
          DeliveryMetrics.orderWriteBack.add(1, { result: 'already_reached' });
          break;
        case 'invalid_transition':
        case 'order_not_found':
          DeliveryMetrics.orderWriteBack.add(1, { result: 'dead_lettered' });
          logDelivery(this.logger, 'error', 'delivery.write_back_refused', {
            deliveryId: delivery.id,
            city: delivery.city,
            status: step,
            error: outcome,
          });
          throw new NonRetryableJobError(outcome);
      }
      await this.deliveries.markOrderSynced(
        delivery.id,
        step,
        this.clock.now(),
      );
    }
  }
}
