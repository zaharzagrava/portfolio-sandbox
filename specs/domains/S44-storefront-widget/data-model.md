# Data model: S44 — Embeddable storefront widget

Both tables are owned by `domain:developer-platform` (`db/ownership.ts`: `WidgetSite` exists, `WidgetSiteChange` is added). No foreign key to another domain's table (IX.4, FR-040).

## WidgetSite (expanded)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | generated **before** insert (SecretBox context `widget-site:<id>`) |
| shopId | uuid NOT NULL | plain ID, **no FK** after the contract step; indexed `(shopId, createdAt, id)` for keyset listing |
| name | varchar(60) NOT NULL default 'Storefront widget' | 1–60 chars |
| publishableKey | varchar UNIQUE NOT NULL | `^pk_live_[A-Za-z0-9_-]{24}$` (CHECK), immutable |
| allowedOrigins | jsonb/text[] NOT NULL | CHECK 1–10 entries; normalised, deduplicated |
| featuredProductIds | uuid[] NOT NULL default '{}' | ≤ 12 (CHECK) |
| theme | jsonb NOT NULL default '{}' | allowlisted keys/values (`domain/theme.ts`) |
| killSwitch | boolean NOT NULL default false | |
| identitySecretSealed | text NOT NULL | `SecretBox` sealed with context `widget-site:<id>`; legacy rows re-sealed once |
| previousIdentitySecretSealed | text NULL | same context |
| previousSecretExpiresAt | timestamptz NULL | decided against the injected clock at use time |
| version | integer NOT NULL default 1 | optimistic concurrency (`PATCH expectedVersion`) |
| shopName | text NOT NULL default '' | R3 copy |
| shopStatus | text NOT NULL default 'ACTIVE' | `ACTIVE` / `SUSPENDED` / `DELETING` / `DELETED` |
| shopVersion | bigint NOT NULL default 0 | monotonic; updates only when the incoming value is greater |
| createdAt, updatedAt | timestamptz | |

Invariants: previous secret and its expiry are both null or both set; a site of a non-`ACTIVE` shop answers `410 widget_disabled` regardless of `killSwitch`.

### State transitions (kill switch)

`killSwitch false ⇄ true` by `PUT kill-switch {on}`; same value → no row change, no history, no event. a real change bumps `version` by 1 (spec AS-39; a repeat leaves it unchanged, AS-40); history and event record it.

### Shop copy decision table (`domain/shop-copy.ts`)

| Incoming `shopVersion` vs stored | Action |
|---|---|
| greater | apply name/status, set version |
| equal or lower | ignore (duplicate or out of order) |

## WidgetSiteChange (new, append-only)

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| siteId | uuid NOT NULL | FK to `WidgetSite(id)` **ON DELETE CASCADE** (same domain; history removed with the site) |
| shopId | uuid NOT NULL | for shop purge, no FK |
| change | text NOT NULL | `kill_switch_on` / `kill_switch_off` (history rows); other changes appear as events only |
| fromValue, toValue | text NULL | kill-switch before/after |
| actorId | uuid NULL | null for system actions (shop status) |
| at | timestamptz NOT NULL | injected clock |

Index `(siteId, at DESC, id)` for keyset paging.

## Migrations (expand / backfill / contract)

1. **Expand**: add columns with defaults, create `WidgetSiteChange`, add CHECKs as `NOT VALID` then `VALIDATE`; `lock_timeout` set; registry entry.
2. **Backfill (script/job, not in a migration transaction)**: shop copy through `ShopQueryService.getShopsByIds` in batches ≤ 500; re-seal identity secrets with context; idempotent and resumable.
3. **Contract**: drop `WidgetSite.shopId → Shop(id)` FK in a later migration.

## Redis keys (non-durable)

| Key | Content | TTL |
|---|---|---|
| `widget:site:<key>` | site record projection for authorize (`l1: 'never'`) | cache TTL, invalidated on write |
| `widget:unknown:<key>` | negative entry for well-formed unknown keys | ≤ 30 s, cleared on create |
| `widget:config:<key>:<origin>` | shaped config with stale-on-error 600 s | fresh 60 s |
| `widget:jti:<siteId>:<jti>` | single-use marker | token `exp` + 60 s |

## Non-entities

Hand-off token (never stored), widget session token (never stored; in iframe memory only), allowed origin (a normalised string).
