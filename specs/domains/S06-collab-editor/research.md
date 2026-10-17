# Research: S06 — Collaborative listing drafts

No NEEDS CLARIFICATION remains. Each decision follows `questions.md` defaults and the code read on 2026-10-16.

| # | Decision | Rationale | Alternatives rejected |
|---|---|---|---|
| D-1 | Keep Yjs + y-protocols (already in `room.ts`) and the y-websocket binary protocol | Spec Provides names it; convergence, duplicate and out-of-order handling are CRDT properties (FR-013) | Operational transform: needs a central sequencer |
| D-2 | Publish = claim (lease) → freeze → snapshot object → one DB transaction (`ProductCommandService` + version + status + outbox) | FR-026: no network I/O in a transaction; exactly-once by conditional updates on the lease id | Single long transaction around S3: holds a connection |
| D-3 | `ProductCommandService.update` already joins the ambient `TransactionRunner.run` (it calls `runner.run`); an unchanged update returns the current view with the same `version` | Verified in `product-command.service.ts:110-143`; unchanged is detectable without a sibling change | Wait for an S05 outcome type |
| D-4 | Validation uses `ProductValidationError.issues` thrown by `create/update`; to return `422` **before** claiming effects, publish pre-validates by calling the S05 input parser through the exported error, inside the transaction that is rolled back on error | S06 must not copy product limits (questions CONTRACT) | Copying limits into S06 |
| D-5 | Ability check on each update = in-memory `ability` of the connection, refreshed by (a) backplane event, (b) 60 s re-check, (c) connect; decision uses `can(role, 'products.write')` from tenancy (needs export, see gaps.md follow-up) | Per-update DB read would cost a query per keystroke | DB read per update |
| D-6 | Backplane = Redis pub/sub channel `collab:revoke` (best effort, 250 ms publish timeout); guarantee comes from the 60 s re-check | AS-24 states the guarantee; `libs/infrastructure/redis-pubsub` does not exist, so the adapter lives in `catalog/infra/collab-backplane.ts` behind a port (no new library) | Kafka topic for instant kick (latency) |
| D-7 | Ticket = HS256 JWT with a dedicated key `collab_ticket_key`, `iss=marketplace-collab`, `aud=collab:<draftId>`, `jti`, `exp=iat+60`; single use by `SET jti NX EX 60` executed after the room accepts the join | FR-009; `4001` redirect happens before consumption (AS-46) | Reusing `jwt_secret` |
| D-8 | Open-draft cap: `pg_advisory_xact_lock(hashtext(shopId))` then conditional insert counting `DRAFT`/`PUBLISHING` | Atomic with no table-wide lock; a CHECK cannot count rows | Serializable isolation (retry storms) |
| D-9 | Keyset cursor `(updatedAt, id)` opaque, HMAC-free base64url JSON bound to shop + filter (same pattern as `product-cursor.ts`) | III.10, reuse of the S05 shape | Offset paging |
| D-10 | Store retry: 3 attempts per cycle, exponential backoff with full jitter (50 ms base, 1 s cap), pending kept; conflict handling reads the item and compares bytes | FR-035, FR-037 | Failing the room on first error (today) |
| D-11 | Large update split in ≤ 300 KB entries, written in sequence order, each conditional | DynamoDB item limit 400 KB | Rejecting large updates |
| D-12 | Compaction pages the log by 100 keys, stores snapshot, moves the pointer with a conditional "greater than" update, then trims; superseded snapshot keys recorded and removed by the daily job after 10 min | FR-036, bounded memory (A25) | Deleting on compaction (races with loaders) |
| D-13 | Ring watcher polls the registry every 2 s (already specified) and, on change, closes rooms whose owner changed: flush → compact → close `4001` | FR-034 | Event-driven ring (needs another channel) |
| D-14 | Ping 30 s, terminate after one missed answer (2 periods = 60 s as AS-20) | existing behaviour kept | — |
| D-15 | `apps/collab` boots alone: `CollabModule` imports Config, Redis, Dynamo, Storage, Tenancy (for `ShopAccessService`), Identity-free ticket verifier | L-018, L-015 | Relying on monolith modules |
| D-16 | Brand is required at publish (`422 listing_invalid`, field `brand`), not defaulted to `Unbranded` | S05 follow-up; money/catalog data must not be invented | Keeping the fallback |
| D-17 | Idempotency via `@Idempotent` interceptor of `libs/infrastructure/idempotency` (S54), scope = shop + route | questions CONTRACT; exists in repo | Own table |
| D-18 | Metrics names `collab_*`/`drafts_*` with bounded labels (`reason`, `code`, `outcome`) | AS-54, III observability | Per-draft labels (cardinality) |
