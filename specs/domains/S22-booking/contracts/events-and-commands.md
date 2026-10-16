# Events and commands (S22)

Envelope `{eventId, type, version: 1, occurredAt, aggregateId}`. Outbox rows are written in the owning transaction (IX.6). Aggregate type `launch_events`, so the topic is `launch_events.events` (research D-6, S28's constant).

| Type | Payload | Key |
|---|---|---|
| `launch_events.event_created` | `{launchEventId, shopId, title, startsAt, salesOpenAt, seatCount}` | `launchEventId` |
| `launch_events.booking_confirmed` | `{holdId, launchEventId, shopId, userId, seats[], bookingIds[], confirmedAt}` | `holdId` |
| `launch_events.event_sold_out` | `{launchEventId, shopId}` | `launchEventId` |
| `launch_events.event_closed` | `{launchEventId, shopId, reason: 'organizer' \| 'started'}` | `launchEventId` |

Command (SQS, single consumer S10): `orders.booking_voucher_requested` v1 `{holdId, bookingIds[], launchEventId, shopId, userId, seatCount}`, dedupe key `booking-voucher:<holdId>`. Best-effort: a booking never waits on it.
