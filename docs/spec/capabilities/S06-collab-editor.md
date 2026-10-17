---
id: S06
title: Collaborative listing drafts - real-time co-editing, versions, publish to a product
kind: capability
status: draft
generated_at: 6c4c54d7
depends_on: [S01, S03, S05, S49, S50, S53, S54]
concepts: [problem-json-errors, outbox-task-queue, job-scheduler-lease, rate-limit-policy, tenant-shop-rbac, transaction-runner, idempotency-key]
models: []
scope:
  - packages/backend/libs/domains/catalog/api/drafts.controller.ts
  - packages/backend/libs/domains/catalog/application/drafts.service.ts
  - packages/backend/libs/domains/catalog/application/room.ts
  - packages/contracts/src/catalog/drafts.ts
---
# S06 - Collaborative listing drafts
## Purpose
A shop's team co-edits a product listing draft in real time (conflict-free merged editing in rooms). Write permission is checked on join and on every update, members keep named versions, and one member publishes the draft as a new product or a new revision of an existing one, exactly once, through the exported product command service of S05.

## Entry points
- `POST /shops/:shopId/drafts` creates a draft (blank, or from a product of the same shop) with `products.write`; `GET /shops/:shopId/drafts` lists them with a keyset cursor (`products.read`).
- `POST /shops/:shopId/drafts/:draftId/connect` returns the editing address of the owning instance, a 60 second ticket and the permission level.
- `POST /shops/:shopId/drafts/:draftId/archive` archives a draft in `DRAFT`.
- `GET|POST /shops/:shopId/drafts/:draftId/versions` and `GET .../versions/:versionId` list, create and read named versions.
- `POST /shops/:shopId/drafts/:draftId/publish` publishes with an `Idempotency-Key`.
- `wss://<instance>/collab/<draftId>?ticket=` speaks the y-websocket protocol plus one permission-denied message.
- Consumers of `tenancy.member_removed`, `tenancy.member_role_changed`, `tenancy.shop_status_changed`, `tenancy.shop_offboarding_started` and `tenancy.shop_deleted` (consumer group `catalog-drafts`).
- Jobs `drafts.release-stale-publishing` (every minute) and `drafts.purge-superseded-snapshots` (daily).

## Rules
- **S06.R-01** A draft belongs to one shop for its whole life; the shop and the creator come from the request context, never from the body, every lookup carries the shop, and another shop's draft or version is indistinguishable from an unknown one (`404 draft_not_found` / `version_not_found`). [proof: S06 AS-01, S06 AS-08]
- **S06.R-02** Bodies are strict: unknown fields, a title outside 1-120 characters, a non-UUID `productId` or a version name outside 1-80 characters (or with control characters) give `400 validation_failed`. [proof: S06 AS-03, S06 AS-41]
- **S06.R-03** Every route is checked in the order `401`, `404 shop_not_found`, `403 permission_denied`, then `403 shop_suspended` / `409 shop_offboarding` for writes. [proof: S06 AS-06]
- **S06.R-04** A draft started from a product reads it through `ProductCommandService.getForShop`, records its version as `baseProductVersion`, refuses an archived product (`409 product_archived`) and answers `404 product_not_found` for a missing or foreign one. [proof: S06 AS-02, S06 AS-04]
- **S06.R-05** A shop holds at most 200 drafts in `DRAFT` or `PUBLISHING`, enforced atomically (`409 draft_limit_reached`). [proof: S06 AS-05]
- **S06.R-06** Statuses move only `DRAFT -> PUBLISHING -> PUBLISHED`, `PUBLISHING -> DRAFT` and `DRAFT -> ARCHIVED`, each as a conditional update that asserts one row; anything else is `409 invalid_transition` with `currentStatus`, and archiving `PUBLISHING` is `409 publish_in_progress`. [proof: S06 AS-11, S06 AS-34] [code: packages/backend/libs/domains/catalog/domain/draft-status.ts#applyDraftTransition]
- **S06.R-07** The list is a keyset page (`updatedAt` then `id`, descending) with an opaque cursor bound to the shop and filter and `limit` 1-100 (default 20). [proof: S06 AS-07]
- **S06.R-08** Connect is rate limited to 30 per minute per user and fails closed; with no editing instance registered it answers `503 collab_unavailable` with `Retry-After: 5`; `canWrite` is true only for a holder of `products.write` on a `DRAFT`. [proof: S06 AS-09, S06 AS-10]
- **S06.R-09** A ticket lives 60 seconds, is signed with a dedicated key, pins `HS256`, carries issuer, audience, `jti`, user, shop, draft and level, and is accepted once; a redirect to the owner does not consume it. The `Origin` is checked against an allowlist and the ticket never appears in a log. [proof: S06 AS-12, S06 AS-13, S06 AS-46]
- **S06.R-10** The draft document merges concurrent, duplicate and out-of-order updates without loss, and a reconnecting client receives only what it lacks. [proof: S06 AS-14, S06 AS-15, S06 AS-16, S06 AS-17]
- **S06.R-11** Presence is owned per connection, capped at 8 KiB, removed on close or after 30 seconds of silence and never persisted. [proof: S06 AS-18]
- **S06.R-12** A room accepts 50 connections and 5 per user, frames up to 512 KiB, 2 MiB of document and 200 frames per second, each with its own close code; dead peers are terminated after one missed ping. [proof: S06 AS-19, S06 AS-20] [code: packages/backend/libs/domains/catalog/domain/frame-policy.ts#classifyFrame]
- **S06.R-13** A room loads once, unloads 30 seconds after the last editor leaves, and a join during the unload waits for it. [proof: S06 AS-21]
- **S06.R-14** Write permission is checked on every update; a denied write is dropped, answered with the permission-denied message, counted and logged without content, and the connection stays open. The empty state frame that every client sends to answer the server's first sync message is not a write and is never denied. [proof: S06 AS-22, S06 AS-23] [code: packages/backend/libs/domains/catalog/domain/frame-policy.ts#abilityAllows]
- **S06.R-15** Removal from the shop closes the member's sockets with `4003` within 5 seconds, and a lost notification is covered by a 60 second batched re-check; events only trigger a fresh read, they never grant. A shop that is no longer active closes its rooms with `4003 shop_inactive`. [proof: S06 AS-24, S06 AS-25, S06 AS-26]
- **S06.R-16** On `tenancy.shop_deleted` the drafts, versions, snapshots and log entries of the shop are purged in transactions of at most 100 drafts, resumably. [proof: S06 AS-27]
- **S06.R-17** Publish claims the draft with a conditional `DRAFT -> PUBLISHING` update carrying a 60 second lease, freezes the room through its owner within 3 seconds, validates the content with the limits of S05 (brand is required; a draft without a category is published under `uncategorized`), and in one transaction applies it through `ProductCommandService`, writes the `published` version, completes the draft on the lease id and appends `catalog.draft_published`; no network call is made inside the transaction. [proof: S06 AS-28, S06 AS-29, S06 AS-31, S06 AS-38]
- **S06.R-18** A product that changed since the draft started gives `409 product_version_conflict` with `currentVersion` unless the publisher acknowledges that version; a missing or archived product gives `409 product_not_found` / `product_archived`. [proof: S06 AS-30, S06 AS-32]
- **S06.R-19** Publish needs an `Idempotency-Key`: a replay returns the stored result, an in-flight twin gives `409 request_in_flight`, a changed body `422 idempotency_key_reuse`, and a key is forgotten after 24 hours. [proof: S06 AS-33]
- **S06.R-20** Of concurrent publishes, or a publish and an archive, exactly one wins; a failed publish releases the claim and leaves the draft editable; an expired lease is reclaimed by a job and a publisher that lost its lease cannot complete. [proof: S06 AS-35, S06 AS-36, S06 AS-37]
- **S06.R-21** The spec table is rendered into the description as a "Specifications" section and parsed back; the two are exact inverses, and publishing an unchanged draft changes no product field. [proof: S06 AS-39] [code: packages/backend/libs/domains/catalog/domain/listing-doc.ts#renderSpecs]
- **S06.R-22** A named version is an immutable snapshot taken after a flush barrier, at most 200 per draft, listed by keyset; a snapshot that cannot be read gives `503 version_unavailable` with `Retry-After`. [proof: S06 AS-40, S06 AS-42, S06 AS-43, S06 AS-44]
- **S06.R-23** Room ownership is consistent hashing with 256 virtual nodes per instance; an instance that does not own a draft closes with `4001` and the owner's address, and a room that is no longer owned flushes and closes with `4002`. [proof: S06 AS-45, S06 AS-46, S06 AS-47, S06 AS-48] [code: packages/backend/libs/domains/catalog/domain/hash-ring.ts#HashRing]
- **S06.R-24** Durable state is a snapshot plus an ordered log written conditionally on the sequence number; two writers never fork it, an identical-bytes conflict is a success, a genuine conflict evicts the loser (`4002`). [proof: S06 AS-49, S06 AS-50, S06 AS-52]
- **S06.R-25** Compaction stores a snapshot, moves the pointer forward only, then trims the log; entries over 300 KB are split; transient store errors are retried and degrade writers (`4013`) only after 8 MiB or 30 seconds of backlog. [proof: S06 AS-51, S06 AS-52, S06 AS-53]
- **S06.R-26** Metrics carry no draft, shop or user label, logs carry no ticket or content, readiness is true only after ring registration, and shutdown goes readiness, ring, flush, close. [proof: S06 AS-54, S06 AS-55]
- **S06.R-27** The two jobs are idempotent: stale `PUBLISHING` rows go back to `DRAFT`; superseded snapshots past 10 minutes and unreferenced version objects older than 1 hour are deleted, referenced ones kept. [proof: S06 AS-56]

## Behaviors
- **S06.B-01** Given a member with `products.write`, when they post `{title}`, then `201` with a `DRAFT` and no log entry exists yet. [proof: S06 AS-01]
- **S06.B-02** Given two editors on one draft, when both type at once, then both documents and the stored state are identical. [proof: S06 AS-14]
- **S06.B-03** Given a read-only member, when they send an update, then it is dropped, they get `read_only`, and the socket stays open. [proof: S06 AS-22]
- **S06.B-04** Given a draft with edits made a moment ago, when a member publishes with a key, then the product contains them and the draft is `PUBLISHED`. [proof: S06 AS-28]
- **S06.B-05** Given a Postgres failure during publish, when the request fails, then the draft is `DRAFT` again and a retry with the same key succeeds. [proof: S06 AS-36]

## Lifecycles
Draft: `DRAFT -> PUBLISHING -> PUBLISHED`, `PUBLISHING -> DRAFT` on failure or lease expiry, `DRAFT -> ARCHIVED`. Version kinds: `named`, `published`.

## Owns
- Tables: `ListingDraft`, `ListingDraftVersion`; DynamoDB `DocUpdates`; objects `drafts/<draftId>/snap-<seq>` and `versions/<versionId>`.
- Events: `catalog.draft_published` v1 on topic `drafts.events`.
- Rate policies: `catalog.draft-connect.user` (30/min), `catalog.draft-write.shop` (120/min), `catalog.draft-publish.shop` (10/min).
- Jobs: `drafts.release-stale-publishing`, `drafts.purge-superseded-snapshots`.

## Decisions
- The document is a Yjs CRDT; the server never merges by hand.
- The snapshot object is written before the publish transaction, so no network call happens inside it; orphans are removed by the daily job.
- Events are triggers, the grant always comes from a fresh membership read.
- Brand is required at publish; there is no `Unbranded` fallback.

## Known gaps
- The instance-to-instance endpoints of the room owner (`freeze`, `unfreeze`, `flush`, under `/api/internal/collab/:draftId/`) are signed with an HMAC under the ticket key; `unfreeze` is an addition to the contract so that a failed publish lets the room accept writes again.
- A ticket is consumed just before the upgrade completes (after the ownership and draft checks), not after the room accepted the join: a join that the room then refuses (room full) has used the ticket.
- Latency at 50 editors (SC-001), publish p95 (SC-004) and fleet capacity (SC-007) have no automated proof; they are listed in `specs/UNVERIFIED.md`.
- Restoring a version into the live draft, comments and rich text are not built.
