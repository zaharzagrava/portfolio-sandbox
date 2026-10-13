# Data model: S37 share links

Owner of every store below: domain `marketing` (share-link half). No other capability reads or writes them (AS-64). Nothing here is a PostgreSQL table; `check:table-ownership` cannot see these stores, so ownership is recorded in the store definitions (L7).

## DynamoDB table `Links` (durable)

Key: `code` (HASH). One item shape for links, one for owner counters.

**Link item**

| Attribute | Type | Rules |
|---|---|---|
| `code` | S | generated: 7 chars `0-9A-Za-z`; custom: 4–32 chars `[a-z0-9]` and single dashes, no leading/trailing dash |
| `kind` | S | `generated` \| `custom` (new; rows without it read as `generated` when `code` is 7 chars of the base-62 alphabet and has no dash, else `custom`) |
| `ownerId` | S | user id; no foreign key; never leaves the API (FR-011) |
| `destination` | S | normalised https URL ≤ 2,048, host lower case, no `ref` |
| `status` | S | `ACTIVE` \| `DISABLED` (new; absent reads as `ACTIVE`). `EXPIRED` is derived, never stored |
| `createdAt` | S | ISO-8601 UTC ms from the clock |
| `updatedAt` | S | ISO-8601; equals `createdAt` at create (new) |
| `expiresAt` | S? | ISO-8601; expired iff `now >= expiresAt`. Legacy rows carry `expiresAtEpoch` (N); read as `expiresAt` when `expiresAt` is absent, never written again |
| `disabledAt` | S? | set once by disable |
| `purgeAtEpoch` | N? | TTL attribute: (`expiresAt` or `disabledAt`) + 13 months, in epoch seconds; rows without expiry or disable have none (new; replaces `expiresAtEpoch` as the TTL attribute) |
| `sk` | S | `createdAt#code`, sort key of `byOwnerV2` |

**State machine** (`domain/link-state.ts`): `ACTIVE --disable--> DISABLED` (final). Derived `EXPIRED` when `ACTIVE` and `now >= expiresAt`. `PATCH` and `disable` are allowed only from `ACTIVE` and not expired, enforced by `ConditionExpression: ownerId = :o AND (attribute_not_exists(#status) OR #status = :active) AND (attribute_not_exists(expiresAt) OR expiresAt > :now)`; a failed condition re-reads and answers `404` (not found/other owner) or `409 link_not_active`.

**Owner counter item**: `{code: "#owner#<ownerId>", activeCount: N}` (the `#` cannot occur in a valid code, so it cannot collide with a link; it is excluded from `byOwner` by having no `ownerId`/`sk`). Create: `TransactWriteItems` of the link `Put` (`attribute_not_exists(code)`) and `Update ADD activeCount 1` with `attribute_not_exists(activeCount) OR activeCount < :max`. Disable: status update and `ADD activeCount -1` in one transaction. The counter has no TTL.

**Indexes**: `byOwner` (existing: `ownerId` / `createdAt`) is kept for backfill; `byOwnerV2` (`ownerId` HASH, `sk` RANGE, projection ALL) serves the list. Backfill of `sk`, `status`, `kind`, `updatedAt` on legacy rows is done by the rebuild job (idempotent, conditional on `attribute_not_exists(sk)`). Reads tolerate missing attributes meanwhile.

**Access patterns**: redirect `GetItem(code)`; create `TransactWriteItems`; list `Query byOwnerV2 ScanIndexForward=false Limit=limit+1`; PATCH/disable `UpdateItem` with condition; attribution `BatchGetItem` ≤ 100; rebuild `Scan` pages.

`dynamodb/Links.json` changes: `TimeToLiveAttribute: purgeAtEpoch`, `sk` attribute and `byOwnerV2`, `_design.owner: "marketing (S37)"` and the access-pattern list above. Expand-only for deployed tables: add the index and attribute, switch the TTL attribute last, after the job has written `purgeAtEpoch` for rows that have `expiresAt` (rows already past expiry get `purgeAtEpoch = now + 13 months`).

## Redis (derived; owner `marketing`)

| Key | Content | TTL |
|---|---|---|
| `share-links:id-seq` | lease counter (INCRBY by 1,000) | none (counter) |
| `share-links:bloom` | existence filter (100M entries, 1% false positive) | none |
| `share-links:bloom:ready` | marker, set last by the rebuild | none |
| `share-links:bloom:lock` | rebuild lock | 10 min |
| `link:v1:<code>` | cached link row or remembered miss | fresh 1 h, stale up to 24 h, miss 60 s |

Counter loss or a key change is not detected by the lease; it surfaces as generated-code collisions that the retry absorbs (AS-07). `share-links:id-seq` has an owner note in `id-lease.ts` and here.

## ClickHouse (derived from the log; owner `marketing`)

`link_clicks` (unchanged DDL, 13-month TTL, `ReplacingMergeTree`, order `(code, ts, click_id)`). Statistics read it with `uniqExact(click_id)` (R-8). `link_clicks_minute` and its view stay as they are (no read from S37 after this change); the DDL gets an owner header comment.

## Topic `links.events`

Event `link.clicked` v1, aggregate `links/<code>`, key = code; see `contracts/events.md`. Producers: `ShareLinksModule` (origin) and `edge-be`. Consumer: `ShareLinksProjectorModule` (`link-clicks`).

## Entities and validation (from the spec)

- **Short link**: rules above; code never reassigned while the row exists (13 months after expiry/disable).
- **Click**: immutable; `{clickId (uuidv7), code, ts, country ("" or A–Z×2), referer (origin or ""), viaEdge}`.
- **Idempotency record**: platform-owned (PostgreSQL), keyed by user and key, 24 h; not a share-link table.
- **Lease**: process-local `[next, end)` over the shared counter, block 1,000.
- **Config** (validated at startup): `share_link_code_key`, `share_link_base_url`, `share_link_max_per_owner`, `share_link_edge_secret`, `share_link_reserved_aliases`, plus `front_host` (https origin).
