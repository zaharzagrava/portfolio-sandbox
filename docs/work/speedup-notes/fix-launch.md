# Fix: "20 joins at once make one ticket" failed in the full run (launch-events-queue)

What failed: the test says the waiting line grows by exactly one per buyer, but the line had SHRUNK (expected 12, got 2). It passed alone.

Cause: the worker wiring specs start the real worker app, which starts a one-second timer that lets people in from every waiting line (the "admitter"). When a spec closed that app, the timer was NOT stopped: it was only stopped by a "real shutdown signal" hook, which app.close() does not run. So the old app kept letting people in, on the shared Redis, during the next files. The queue spec then saw its line being emptied by a ghost. Reproduced on shard 7 by replaying the 17 files of list-8 (the queue test failed with "expected 2 to be 12").

Fix: libs/domains/launch-events/infra/admitter.ts now also stops its timer when the app is closed (onModuleDestroy). This is also right for real life.

live-comments (e-mail check): NOT investigated (no time left). Its list is list-2 (place 16). Not known whether the same ghost timer is its cause.

Check: after the fix, the queue spec passes (21 of 21) alone. The full list-8 replay was not repeated after the fix; a three-file replay (offline-sync-wiring, flash-sale-lifecycle, queue) is in the report.
