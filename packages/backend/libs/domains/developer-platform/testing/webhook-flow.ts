import { v7 as uuidv7 } from 'uuid';
import {
  createdWebhookEndpointSchema,
  type CreatedWebhookEndpoint,
} from '@marketplace-sandbox/contracts';
import type { InMemoryTaskQueue } from '@app/infrastructure/sqs/in-memory-task-queue';
import {
  DeliveryLog,
  type AttemptRecord,
  type DeliveryMessage,
  type DeliveryRecord,
} from '../domain/webhook-ports';
import { WebhookOrdersConsumer } from '../infra/webhook-consumers';
import {
  orderPaidEvent,
  type OrderLineSeed,
  type WebhookKit,
  type WebhookWorld,
} from './webhook-e2e.fixture';
import { createLane, feed, type Lane } from './webhook-lane';

/**
 * What the delivery and address specs share: an endpoint through the dashboard route, an order routed to it through the
 * real consumer (so the delivery record and the queue message are exactly what production creates), and reads of the
 * delivery log through its port.
 */
export interface Flow {
  lane: Lane;
  endpoint(
    world: WebhookWorld,
    url: string,
    extra?: Record<string, unknown>,
  ): Promise<CreatedWebhookEndpoint>;
  /** Routes one paid order of the shop and returns the message queued for the endpoint (removed from the queue). */
  route(
    world: WebhookWorld,
    endpointId: string,
    options?: { lines?: OrderLineSeed[]; occurredAt?: Date },
  ): Promise<DeliveryMessage>;
  delivery(message: {
    endpointId: string;
    eventId: string;
  }): Promise<DeliveryRecord>;
  attempts(endpointId: string, eventId?: string): Promise<AttemptRecord[]>;
  failingSince(endpointId: string): Promise<Date | null>;
}

export function createFlow(t: WebhookKit, queue: InMemoryTaskQueue): Flow {
  const lane = createLane(t, queue);
  const log = () => t.app.get(DeliveryLog, { strict: false });
  return {
    lane,
    async endpoint(world, url, extra = {}) {
      const res = await t
        .as(world.owner)
        .post(t.base(world))
        .send({ url, events: ['order.paid'], ...extra });
      if (res.status !== 201)
        throw new Error(`create: ${res.status} ${JSON.stringify(res.body)}`);
      return createdWebhookEndpointSchema.parse(res.body);
    },
    async route(world, endpointId, options = {}) {
      const event = orderPaidEvent({
        orderId: uuidv7(),
        shops: [{ shopId: world.shop.id, lines: options.lines }],
        occurredAt: options.occurredAt,
      });
      const dead = await feed(t.app.get(WebhookOrdersConsumer), [event]);
      if (dead.length) throw new Error(`event refused: ${dead[0].reason}`);
      const [message] = lane.take(endpointId);
      if (!message) throw new Error('nothing was queued for the endpoint');
      return message;
    },
    async delivery(message) {
      const record = await log().getDelivery(
        message.endpointId,
        message.eventId,
        t.clock.now(),
      );
      if (!record) throw new Error('no delivery record');
      return record;
    },
    attempts: async (endpointId, eventId) =>
      (
        await log().listAttempts(
          endpointId,
          { limit: 100, eventId },
          t.clock.now(),
        )
      ).reverse(),
    async failingSince(endpointId) {
      const [row] = await t.rows<{ failingSince: Date | null }>(
        `SELECT "failingSince" FROM "WebhookEndpoint" WHERE id = :id`,
        { id: endpointId },
      );
      return row?.failingSince ?? null;
    },
  };
}
