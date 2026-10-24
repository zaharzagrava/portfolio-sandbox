# Timers and loops that kept running after the app was closed

Question asked: which background timers, loops and listeners are only stopped by a real "stop" signal (Ctrl-C / SIGTERM) and NOT when a test closes the app with `app.close()`?

## Fixed

1. `libs/infrastructure/jobs/job-worker.service.ts` (JobWorker)
   - Problem: the loop that picks up queued jobs was stopped only through the shutdown list, which only a real signal runs. After `app.close()` the loop kept asking the (already closed) database for jobs, logging errors and retrying forever. In a shared test process this is a "ghost" worker that can also grab jobs of a later test file.
   - Change: added a close hook (`onModuleDestroy`) that calls the existing `stop()`.
   - Risk: low. In production the signal path already called `stop()`; the second call finds nothing left to stop and returns at once. The hook runs before the database is closed, so in-flight jobs still get their normal grace time (up to the existing drain limit) and are handed back.

2. `libs/infrastructure/jobs/job-maintenance.service.ts` (JobMaintenance)
   - Problem: same as above for the once-a-second loop that starts scheduled jobs, reaps dead leases and updates queue gauges.
   - Change: same close hook calling the existing `stop()`.
   - Risk: low, same reasoning.

## Checked and already fine (they stop on close)

- Admitter (fixed earlier today), LiveTicker (stops its timer and gives back its leases), LiveViewerRegistry (stops its 5 s report timer, closes viewers), per-stream batchers and keep-alive timers (stopped when the viewer leaves or on close).
- Outbox publisher, clock service, queue metrics, ring heartbeat (fulfilment), consumer-admin sampler, event-loop monitor, collab server, room manager, instance registry.
- Kafka: ProjectionRunner (stops all consumers on close), click aggregator, click-log and aggregate writers.
- Queue consumers (SQS): every worker keeps the `stop` function and calls it on close or shutdown (payments, media, orders, catalog-sync, notifications, chat, shop-functions, fulfilment, seller-onboarding, developer-platform, assistant).
- Redis listeners: cache broadcast (stopped by the cache service), realtime hub, collab backplane.
- Timers that live only for one request or one message (SQS visibility heartbeat, video pipeline heartbeat, SSE heartbeats, timeouts with clearTimeout) end with that work.

## Not changed on purpose (note only)

- GenerationService (assistant): has a 1 s watcher per running generation, cleared when that generation ends. Only registered on the shutdown list, not on close. Left alone: a close hook would have to wait for answers that may take long. Low risk in tests because turns end by their own timeout.
- RedisService and CassandraService: connections are closed only through the shutdown list. Closing them on `app.close()` could break other close hooks that still need them (order matters), so I did not touch it. They do not run loops.
- Settlement consumer, payouts, statements and billing "stop work" flags: flags only, no loops of their own.

## The flaky live-comments test

`live-comments.e2e-spec.ts` "...differs across streams, and no e-mail appears in any payload": the live code in that test uses hand-driven fake timers (not real ones), so the only real timer that could interfere was the Admitter (fixed today). The e-mail check uses `live-<random id>` so a chance clash is not plausible. I found no other timer cause by reading; other possible causes (shared rate-limit counters on one address, shared Redis between files) I could not confirm without running. If it still fails, look at the first failing line in the log (comment returning 429, or history page not having 2 items).

## Checks

- `npx tsc --noEmit`: only 3 errors, all in older e2e spec files that are not touched (`media-processing.e2e-spec.ts`, `edge-worker.e2e-spec.ts`). No new errors.
- No unit spec covers the two edited classes, so no unit tests were run (nothing was started: no database, no servers).
- Nothing committed.
