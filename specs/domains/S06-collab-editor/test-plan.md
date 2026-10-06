# Test Plan: S06 — Collaborative listing drafts (domain `catalog`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/catalog/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `DraftsModule` (HTTP) and `CollabModule` (rooms and the connection server) with the tenancy and identity modules they depend on, the outbox, the rate limiter and the idempotency facility, with the production pipe, filter, prefix and interceptors, against real Postgres (migrated), Redis, DynamoDB Local and MinIO from `docker-compose.test.yaml`. Editors are **real WebSocket clients** speaking the y-websocket protocol (`YClient` helper in `test/fakes/`), never room objects. Time is frozen with the shared clock helper, state is reset in `beforeEach` (including the ring registry), seeding goes through the shared fixture helpers (`createUser`, `createShop(owner)`, `addMember`, `createProduct`, `createDraft`), and every test asserts the response **and** the persisted state (draft rows, version rows, log entries, snapshot objects, outbox rows, delivered messages, close codes).
- Only system-edge dependencies are faked. **Fault injection** uses real mechanisms: a TCP fault proxy in front of Redis and DynamoDB Local (`test/fakes/tcp-fault-proxy.ts`: refuse, hang, delay, drop the reply after forwarding), a Postgres trigger created by the test that raises on `UPDATE` of the product table or `INSERT` into the outbox table, a second Nest app instance (`appA`, `appB`) in one process for routing, split brain, scale-out and cross-instance revocation, and a gated object-store wrapper for unreadable snapshots. Retries and timers use the frozen clock; liveness and idle periods are shortened by configuration, never by sleeping.
- Consumers (`tenancy.member_removed`, `member_role_changed`, `shop_status_changed`, `shop_offboarding_started`, `shop_deleted`) are driven by delivering real envelopes to the real consumer entry point, each with the duplicate-delivery and invalid-payload tests of VII.4 (AS-26, AS-27).
- R1 usage is proven from a test module that imports only `@app/domains/catalog` plus the real S03 and S05 modules.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5): the hash ring, listing document reading and spec render/parse (also `fast-check` round trip), the draft status machine, and the frame policy (which frame types a given ability may apply). No unit tests for controllers, repositories, rooms, consumers or glue.
- UI journey (Playwright, owned by W04, happy path only): `packages/web/tests/listing-editor.spec.ts` — two seller staff open the same draft, both type, see each other's text and cursor, and one publishes. No edge case is re-tested there.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm check:boundaries`; `pnpm check:table-ownership --strict` (zero `catalog` findings for S06 code).
- Contract layer (VII.6): every e2e parses responses with the schemas named in the spec (`draftSchema`, `draftPageSchema`, `draftConnectSchema`, `draftVersionSchema`, `draftVersionDetailSchema`, `draftVersionPageSchema`, `draftPublishResultSchema`) and outbox payloads with `draftEventSchemas`.

Abbreviations for the e2e files (all under `libs/domains/catalog/`):

| Key | File | Top-level `describe` |
|---|---|---|
| D | `drafts-api.e2e-spec.ts` | `Listing drafts API` |
| K | `collab-rooms.e2e-spec.ts` | `Collaborative editing rooms` |
| P | `drafts-publish.e2e-spec.ts` | `Draft publish` |
| V | `draft-versions.e2e-spec.ts` | `Draft version history` |
| R | `collab-routing.e2e-spec.ts` | `Collab routing and durability` |
| E | `drafts-consumers.e2e-spec.ts` | `Draft tenancy event consumers` |
| O | `collab-ops.e2e-spec.ts` | `Collab operations` |

Unit files: `domain/hash-ring.spec.ts` (H), `domain/listing-doc.spec.ts` (L), `domain/draft-status.spec.ts` (S), `domain/frame-policy.spec.ts` (F).

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create blank | D | — | — |
| AS-02 create from a product | D (product `P` seeded through the real S05 service; asserts the first join receives the content) | — | L (spec parse) |
| AS-03 create validation | D (one case per class) | — | — |
| AS-04 missing / other-shop / archived product | D | — | — |
| AS-05 open-draft limit and concurrent create | D (`Promise.all` at 199) | — | — |
| AS-06 access gates, every route | D (table-driven over the eight routes: 401, non-member 404, 403, suspended, offboarding) | — | — |
| AS-07 list pagination | D | — | — |
| AS-08 cross-tenant access | D (all six routes) | — | — |
| AS-09 connect | D | — | — |
| AS-10 connect limits | D (429 with the real limiter, fail-closed with Redis refused via fault proxy, no instance registered) | — | — |
| AS-11 archive and illegal transitions | D | — | S (transition table) |
| AS-12 handshake accepted, early frames | K | — | — |
| AS-13 handshake refused | K (table-driven: each bad-ticket class, origin, replay, deleted draft; log capture asserts no ticket) | — | — |
| AS-14 concurrent edits converge | K | `listing-editor.spec.ts` (two users co-edit, see each other) | — |
| AS-15 duplicate update | K | — | — |
| AS-16 out-of-order updates | K | — | — |
| AS-17 offline resume | K (asserts bytes sent are fewer than the full state) | — | — |
| AS-18 presence | K (asserts the log table is unchanged after presence-only traffic) | — | — |
| AS-19 connection and message limits | K (table-driven, one case per limit and close code) | — | F (size and rate classification) |
| AS-20 dead peer | K (shortened ping period by config) | — | — |
| AS-21 room load, unload, join during unload | K (spy counts snapshot and log reads on the real store) | — | — |
| AS-22 read-only member cannot write | K | — | F (ability × frame type table) |
| AS-23 write lost mid-session | K (role change delivered through the real consumer) | — | — |
| AS-24 member removed (and lost notification) | K on `appA` + `appB`; lost notification forced by dropping the Redis channel through the fault proxy | — | — |
| AS-25 shop no longer active | K | — | — |
| AS-26 event consumers | E (each of the five consumers: duplicate delivery, invalid payload, stale event) | — | — |
| AS-27 shop deleted | E (250 drafts, bounded batches, crash after batch one, redelivery) | — | — |
| AS-28 publish a new product | P (asserts product row, draft row, version row and snapshot object, outbox rows of both events) | `listing-editor.spec.ts` (publish step) | — |
| AS-29 publish a revision | P | — | — |
| AS-30 product changed since the draft | P (including acknowledge and stale acknowledge) | — | — |
| AS-31 invalid listing | P (table-driven per field) | — | L (content reading, invalid typed values) |
| AS-32 product gone | P | — | — |
| AS-33 idempotency | P (replay, in-flight with a gated product write, different body, header classes, TTL with frozen clock) | — | — |
| AS-34 illegal transitions | P | — | S |
| AS-35 concurrent publish | P (`Promise.all` for each of the three races; asserts exactly one product, version and event) | — | — |
| AS-36 failure leaves the draft editable | P (Postgres trigger raises on the product update; retry with the same key) | — | — |
| AS-37 publisher crash and lease | P (job run with the frozen clock; late completion from the old lease affects zero rows) | — | — |
| AS-38 freeze point | P (editor on a real socket; owner unconfirmed via fault proxy → 503) | — | — |
| AS-39 spec table round trip | P (publish, create from product, publish unchanged) | — | L (`fast-check` round trip of render/parse) |
| AS-40 create a named version | V | — | — |
| AS-41 version rules | V | — | — |
| AS-42 list versions | V | — | — |
| AS-43 read a version | V | — | — |
| AS-44 snapshot unreadable | V (gated object store) | — | — |
| AS-45 consistent hashing with virtual nodes (P1105) | — | — | H (determinism, balance within 115%, 1/(N+1)+5% moved, all to the new node, empty ring) |
| AS-46 wrong instance | R (`appA` + `appB`; ticket reused at the owner) | — | — |
| AS-47 instance leaves or crashes | R (graceful stop and a killed heartbeat with the frozen clock) | — | — |
| AS-48 scale out | R | — | — |
| AS-49 split brain | R (two rooms forced for one draft; one log sequence per number) | — | — |
| AS-50 durability and micro-batching | R (counts log entries for N updates in one window) | — | — |
| AS-51 compaction | R (200 flushes, lower-sequence compaction, crash between pointer move and trim) | — | — |
| AS-52 store trouble | R (fault proxy on DynamoDB Local: timeout twice, ack dropped after write, outage past the backlog limit) | — | — |
| AS-53 large update | R | — | — |
| AS-54 metrics and logs | O | — | — |
| AS-55 health and shutdown order | O | — | — |
| AS-56 leftover cleanup | O (job run twice) | — | — |
