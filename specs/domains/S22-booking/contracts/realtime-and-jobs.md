# Realtime topics, jobs, rate limits (S22)

**Topics** (`LaunchEventTopicsModule`, one `TopicRegistry.define` rule per route)
- `queue:<ticket>`: owner only (async policy asks the ticket store; unknown ticket is refused the same way). Event `admitted {eventId, admissionToken, tokenExpiresAt}`.
- `event:<eventId>:seatmap`: public. Event `seats` = `seatMapDeltaSchema {seq, change: 'held'|'booked'|'released', seats[]}`. Clients apply only `last+1`, ignore `seq ≤ last`, refetch on a gap (`seat-map-reducer.ts`).

**Jobs** (S49; idempotent, single-run; an invalid payload is rejected with no effect)
- `launch-events.expire-hold` (per hold, `runAt = expiresAt`)
- `launch-events.open-sales` (per event, `runAt = salesOpenAt`)
- `launch-events.close-event` (per event, `runAt = startsAt`; also organizer-close fan-out)
- `launch-events.reconcile-seats` (every 60 s, concurrency 1; includes the double-booking detector)
- The 1 s admitter timer lives in `LaunchEventsWorkerModule` and stops first on shutdown.

**Rate-limit policies**: `launch.queue.join.user` 10/min fail open; `launch.hold.user` 30/min fail closed; `launch.seatmap.ip` 600/min fail open.

**Metrics** (AS-58, `launch_*`, bounded labels): `launch_admission_stale_leader_total`, `launch_reconcile_repairs_total`, `launch_double_booking_detected_total`, hold-degradation and limiter-failure counters, queue-length gauge for `ON_SALE` events.
