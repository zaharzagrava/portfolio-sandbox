# Events and service contracts: S06

## Produced

`catalog.draft_published` v1 — outbox → topic `drafts.events`, key `draftId`. Envelope `{eventId, type, version: 1, occurredAt, aggregateId}`; payload `{draftId, shopId, productId, productVersion, versionId, publishedBy}`. Schema `draftEventSchemas` in contracts. Appended with `OutboxService.append` inside the publish transaction. No consumer yet.

## Consumed (`DraftsProjectorModule`, own consumer group `catalog-drafts`)

| Event | Payload checked (strict) | Effect | Idempotency |
|---|---|---|---|
| `tenancy.member_removed` v1 `{shopId, userId, role, reason}` | uuid, uuid, known role | backplane `revoke(shopId, userId)` → rooms re-check now | inbox |
| `tenancy.member_role_changed` v1 `{shopId, userId, from, to}` | uuid, uuid, known roles | backplane `recheck(shopId, userId)` | inbox |
| `tenancy.shop_status_changed` v1 `{shopId, from, to, shopVersion}` | uuid, statuses, integer | if `to ≠ ACTIVE` backplane `close(shopId, shop_inactive)` | inbox + shopVersion guard |
| `tenancy.shop_offboarding_started` `{shopId}` | uuid | backplane `close(shopId, shop_inactive)` | inbox |
| `tenancy.shop_deleted` `{shopId}` | uuid | purge ≤ 100 drafts/transaction (versions, snapshots, log) + close rooms; resumable | inbox + delete-by-shop is naturally repeatable |

Events are triggers only; grants come from a fresh `MembershipQueryService` read. Invalid payload → DLQ, no side effect.

## Required from siblings (not edited here; see gaps.md "Sibling-spec follow-ups")

- S05 `ProductCommandService.getForShop/create/update`: exist. `update` joins the ambient transaction (it uses `TransactionRunner.run`); `ProductValidationError { fields }` exists; unchanged update returns the current view (S06 compares `version`).
- S03 `can(role, permission)` exists in `domain/permissions.ts` but is not exported from the barrel; S06 needs it exported (name asked: `roleHasPermission`).
- S03 `ShopAccessService.assertMember`, `MembershipQueryService.getMembersByShopIds`, `ShopScoped`: exist.

## Jobs (S49)

`drafts.release-stale-publishing` (cron `* * * * *`, `fleetConcurrency: 1`): reset `PUBLISHING` rows with expired lease to `DRAFT` (conditional on lease id), ≤ 500 per run. `drafts.purge-superseded-snapshots` (daily, `fleetConcurrency: 1`): delete superseded snapshots past 10 min grace and unreferenced `versions/` objects older than 1 h; page by 100; idempotent. Both register `declareJobType` with a Zod payload contract; scheduling catches `InvalidScheduleError`.

## Rate-limit policies (S50)

`catalog.draft-connect.user` 30/min per user; `catalog.draft-write.shop` 120/min per shop; `catalog.draft-publish.shop` 10/min per shop; all fail closed.
