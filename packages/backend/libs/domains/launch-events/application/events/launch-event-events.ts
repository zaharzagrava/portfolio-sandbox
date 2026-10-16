import {
  LAUNCH_EVENTS_AGGREGATE,
  launchEventEventSchemas,
} from '@marketplace-sandbox/contracts';
import { defineEvent } from '@app/infrastructure/events/define-event';
import type { TopicRegistration } from '@app/infrastructure/events/topic-registry';

/**
 * S22 events (contracts/events-and-commands.md): aggregate `launch_events`, topic `launch_events.events`, key
 * `launchEventId` (`holdId` for a confirmed booking). The `type` is the alias `launchevents.<name>` because the S53 type
 * pattern allows no `_` in the first segment; S28 resolves the alias to the canonical `launch_events.<name>`.
 */
export const LaunchEventCreated = defineEvent(
  'launchevents.event_created',
  LAUNCH_EVENTS_AGGREGATE,
  1,
  launchEventEventSchemas['launchevents.event_created'],
);
export const BookingConfirmed = defineEvent(
  'launchevents.booking_confirmed',
  LAUNCH_EVENTS_AGGREGATE,
  1,
  launchEventEventSchemas['launchevents.booking_confirmed'],
);
export const LaunchEventSoldOut = defineEvent(
  'launchevents.event_sold_out',
  LAUNCH_EVENTS_AGGREGATE,
  1,
  launchEventEventSchemas['launchevents.event_sold_out'],
);
export const LaunchEventClosed = defineEvent(
  'launchevents.event_closed',
  LAUNCH_EVENTS_AGGREGATE,
  1,
  launchEventEventSchemas['launchevents.event_closed'],
);

export const LAUNCH_EVENTS_TOPIC: TopicRegistration = {
  aggregateType: LAUNCH_EVENTS_AGGREGATE,
  retention: 'full-history',
};
