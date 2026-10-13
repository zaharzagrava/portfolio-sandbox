import { Injectable } from '@nestjs/common';
import {
  consumedEventSchemas,
  type ConsumedEventType,
} from '@marketplace-sandbox/contracts';
import type { EventDefinition } from '@app/infrastructure/events/define-event';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import type {
  HandledEvent,
  IdempotencyMechanism,
  Projector,
} from '@app/infrastructure/projections/projector';
import { EventRoutingService } from '../../application/event-routing.service';
import {
  familyOfType,
  NOTIFICATION_SOURCE_TOPICS,
  type NotificationSourceFamily,
} from '../notifications.topics';

/** Payload version every consumed type is read at (`CONSUMED_EVENT_VERSION`); another version is dead-lettered. */
const VERSION = 1;

/**
 * The framework's view of a consumed type: its name, version and the contract schema of `packages/contracts`. These are
 * not the producers' event classes (X.4 forbids importing them); the schema is the consumer-side contract (research R-3).
 */
function consumedDefinition(
  type: ConsumedEventType,
  topic: string,
): EventDefinition<string, string, never> {
  return {
    type,
    version: VERSION,
    aggregateType: topic.replace(/\.events$/, ''),
    topic,
    schema: consumedEventSchemas[type],
    carries: 'delta',
    create: () => {
      throw new Error(`${type} is consumed here, never produced`);
    },
    match: () => null,
  } as unknown as EventDefinition<string, string, never>;
}

/**
 * One consumer per source family (contracts/events.md): it subscribes to the family's topic, the framework validates
 * and routes by type and version, and every batch goes to `EventRoutingService`, which maps, resolves recipients
 * and routes each request in isolation. A duplicate is harmless because every routing step is idempotent (`natural`).
 */
@Injectable()
export abstract class NotificationConsumer implements Projector {
  abstract readonly family: NotificationSourceFamily;
  readonly idempotency: IdempotencyMechanism = 'natural';
  /** Handler attempts per event before the framework dead-letters it (a transient failure never counts). */
  readonly attempts = 3;

  constructor(protected readonly routing: EventRoutingService) {}

  get name(): string {
    return `notifications-${this.family.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
  }

  get topics(): string[] {
    return [NOTIFICATION_SOURCE_TOPICS[this.family]];
  }

  get handles(): HandledEvent[] {
    const topic = NOTIFICATION_SOURCE_TOPICS[this.family];
    return (Object.keys(consumedEventSchemas) as ConsumedEventType[])
      .filter((type) => familyOfType(type) === this.family)
      .map((type) => ({ event: consumedDefinition(type, topic) }));
  }

  async project(events: EventEnvelope[]): Promise<void> {
    await this.routing.consume(this.family, events);
  }
}
