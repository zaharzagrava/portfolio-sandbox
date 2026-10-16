import { v7 as uuidv7 } from 'uuid';
import type { EventEnvelope } from '@app/infrastructure/events/event-envelope';
import { PermanentError } from '@app/infrastructure/projections/errors';
import type { Projector } from '@app/infrastructure/projections/projector';

/** An envelope exactly as the log would carry it, valid or not (no producer-side validation). */
export function envelope(
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: unknown,
  aggregateVersion = 1,
  version = 1,
): EventEnvelope {
  return {
    eventId: uuidv7(),
    type,
    version,
    aggregateType,
    aggregateId,
    aggregateVersion,
    occurredAt: new Date().toISOString(),
    payload: payload as Record<string, unknown>,
  };
}

export const shopCreatedEvent = (
  shopId: string,
  slug: string,
  shopVersion = 1,
) =>
  envelope(
    'tenancy.shop_created',
    'tenancy',
    shopId,
    {
      shopId,
      ownerId: null,
      name: 'Shop',
      slug,
      plan: 'STARTER',
      region: 'eu-central-1',
      shopVersion,
    },
    shopVersion,
  );

export const shopUpdatedEvent = (
  shopId: string,
  slug: string,
  shopVersion: number,
) =>
  envelope(
    'tenancy.shop_updated',
    'tenancy',
    shopId,
    { shopId, name: 'Shop', slug, shopVersion },
    shopVersion,
  );

export const shopStatusEvent = (
  shopId: string,
  from: string,
  to: string,
  shopVersion: number,
) =>
  envelope(
    'tenancy.shop_status_changed',
    'tenancy',
    shopId,
    { shopId, from, to, shopVersion },
    shopVersion,
  );

export const shopDeletedEvent = (shopId: string, shopVersion = 99) =>
  envelope(
    'tenancy.shop_deleted',
    'tenancy',
    shopId,
    { shopId, shopVersion },
    shopVersion,
  );

/** A story event as the outbox relay would deliver it (the payload as the producer wrote it). */
export const storyEvent = (
  type: 'story.published' | 'story.archived',
  payload: {
    storyId: string;
    shopId: string;
    shopSlug: string;
    slug: string;
    version: number;
    locales?: string[];
  },
) => envelope(type, 'stories', payload.storyId, payload, payload.version);

/**
 * Delivers an event to a consumer the way the framework does: a `PermanentError` is a dead letter (nothing applied,
 * processing goes on), any other error propagates (a redelivery).
 */
export async function deliver(
  consumer: Projector,
  event: EventEnvelope | EventEnvelope[],
): Promise<{ delivered: boolean }> {
  try {
    await consumer.project(Array.isArray(event) ? event : [event]);
    return { delivered: true };
  } catch (error) {
    if (error instanceof PermanentError) return { delivered: false };
    throw error;
  }
}
