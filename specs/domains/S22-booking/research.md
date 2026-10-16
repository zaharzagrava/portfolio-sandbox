# Research: S22 — Launch-Event Booking

No NEEDS CLARIFICATION remain; the questions.md defaults are accepted. These decisions settle how, not what.

**D-1 Admission token signing.** Decision: domain port `AdmissionTokenPort` (`sign`/`verify` shaped like the spec's `PurposeTokenService`). Checked today: identity does not export a purpose-token service, and `KeyStore` is an identity internal. The adapter uses `PurposeTokenService` when it exists, otherwise the exported `AccessTokenSigner`/JWKS contract with a pinned ES256 algorithm, purpose claim `admission`, audience `admission:<eventId>`. Rejected: our own key pair and JWKS (duplicates rotation; questions.md says not preferred).

**D-2 Hold ledger authority.** Decision: DynamoDB conditional writes per seat record `{eventId, seat, holdId, fence, expiresAtMs}`, condition "absent or expired at write time", fence = previous + 1. Multi-seat holds (≤10) use `TransactWriteItems` for all-or-nothing, so there is no rollback loop on the happy path; rollback stays conditional on hold ID and fence for Redis cleanup and crash repair. Redis `SET NX PX` per seat is a non-waiting first filter only. Rejected: Postgres `FOR UPDATE SKIP LOCKED` (SC-004 forbids relational hold traffic).

**D-3 Locks.** `DistributedLock` (S52, with fence) is used where a lease is the authority: the admitter leader per event (the lock fence is the admission epoch, checked inside the admit Lua script) and the seat-map rebuild single flight. The per-seat filter stays a plain `SET NX PX` because correctness comes from the ledger (III.6).

**D-4 Atomicity in Redis.** Lua scripts, keys hash-tagged by event: `join` (create or return, 201/200), `admit` (epoch check, one-second bucket, rotating shard start, skip lapsed tickets), `quota-claim` (INCRBY + EXPIRE + cap), `seat-mark` (SETBIT + INCR seq, returns the delta).

**D-5 Confirm protocol.** Seal the ledger (`HELD→CONFIRMING`, conditional on hold ID and fence; expiry uses `HELD→EXPIRED`, so they exclude each other) → one `TransactionRunner.run`: insert `Booking` rows (partial unique index stays), `BookingEvent` rows, quota re-check against bookings, conditional `ON_SALE→SOLD_OUT` when the last seat goes, outbox rows (`booking_confirmed`, `event_sold_out`, voucher command) → finalise the ledger `CONFIRMED` and mark the seat map `booked`. A crash between steps is repaired by the reconciler after 120 s. Replay: shared idempotency facility plus natural re-confirm `200`.

**D-6 Event topic name.** The spec wrote Kafka topic `launch-events.events`; S28's follow-up says its constant is `launch_events.events` because an aggregate type cannot contain `-`. Decision: aggregate type `launch_events`, topic `launch_events.events`. Logged under Spec changes in gaps.md.

**D-7 Status gate on hold.** Authoritative status is `LaunchEvent.status`, mirrored into a short-TTL Redis gate key written by `open-sales`, sold-out and close, and rebuilt from the row on a miss. The cached public page never decides (AS-20). The hold path therefore needs no relational read.

**D-8 Time and randomness.** `Clock` and an injected random source; e2e freezes and advances the clock; the admitter exposes `tick()`.

**D-9 Config.** Schema-validated (S54): `queueMaxLength` (default 2,000,000), human-check provider URL and timeout (2000 ms).

**D-10 Rate limits.** `definePolicies('launch-events', …)`: `launch.queue.join.user` 10/min open, `launch.hold.user` 30/min closed, `launch.seatmap.ip` 600/min open.
