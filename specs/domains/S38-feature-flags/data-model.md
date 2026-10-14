# Data model: S38 Feature flags

Owner of everything below: `domain:experimentation` (`db/ownership.ts`). Models live in `infra/models/`.

## PostgreSQL

### `FeatureFlag` (existing, expanded)

| Column | Type | Notes |
|---|---|---|
| `key` | TEXT PK | check `^[a-z0-9][a-z0-9-]{1,63}$` (exists); immutable; archived keys stay reserved |
| `description` | TEXT NOT NULL default `''` | ≤ 500 (validated in the app) |
| `status` | TEXT NOT NULL | new; check in (`enabled`,`disabled`,`killed`,`archived`); backfill from `enabled` |
| `enabled` | BOOLEAN | kept readable until a contract migration; the app writes `status = 'enabled'` into it for old readers |
| `variants` | JSONB NOT NULL | ≤ 20 |
| `defaultVariant`, `offVariant` | TEXT NOT NULL | must name a variant |
| `rules` | JSONB NOT NULL default `[]` | ≤ 50 |
| `bucketBy` | TEXT NOT NULL default `userId` | new check in (`userId`,`shopId`) |
| `clientSide` | BOOLEAN NOT NULL default false | |
| `owner` | TEXT NOT NULL | 1–100 |
| `expiresAt` | TIMESTAMPTZ NULL | advisory |
| `version` | INTEGER NOT NULL default 1 | per-flag; bumped only by an applied change |
| `createdAt` | TIMESTAMPTZ NOT NULL default now() | new; backfilled with `updatedAt` |
| `updatedAt` | TIMESTAMPTZ NOT NULL | |

Index (new): partial `("key") WHERE status <> 'archived'` for the 500-flag count and ruleset load.

### `FlagRuleset` (new)

`id SMALLINT PK CHECK (id = 1)`, `version BIGINT NOT NULL`, seeded with `max(FeatureFlag.version)` (at least 1). Written only inside a flag change transaction: `SELECT … FOR UPDATE`, then `UPDATE … SET version = version + 1 RETURNING version` when a change is applied.

### `FlagAudit` (existing, expanded)

| Column | Notes |
|---|---|
| `id` BIGSERIAL PK | history tiebreaker |
| `flagKey` TEXT | no FK (outlives the flag) |
| `actorId` UUID | now `NOT NULL`; legacy NULL rows backfilled with `00000000-0000-0000-0000-000000000000` |
| `action` | `create` `update` `kill` `restore` `archive` |
| `before`, `after` JSONB | `flagSchema` shape; `before` null on create |
| `requestId` TEXT | new, nullable for legacy rows, set for every new row |
| `at` TIMESTAMPTZ | |

Index exists (`flagKey, at DESC`); add `(flagKey, at DESC, id DESC)` for the exact keyset order. Append-only: the repository exposes `append` and reads only.

### Outbox

One row per applied change through `OutboxService.append` (technical table, IX.3): `experimentation.flag_changed` v1 (`eventId`, `occurredAt`, `flagKey`, `action`, `flagVersion`, `actorId`), key `flagKey`.

## Redis (derived, never the source of truth)

| Key | Content | TTL |
|---|---|---|
| `flags:ruleset` | JSON snapshot `{version, flags[]}` of all non-archived flags, validated by `flagRulesetSnapshotSchema` on read | 3600 s, refreshed by publish and by the repair job |
| `flags:evals:<YYYY-MM-DD>` | hash `flagKey → count` | 40 days |
| channel `flags` (realtime) | the ruleset version only | – |

The old `flags:ruleset-version` key is no longer read or written (delete after one release; harmless).

## Snapshot (`flagRulesetSnapshotSchema`)

`{ version: int ≥ 0, flags: [{ key, status (enabled|disabled|killed), variants, defaultVariant, offVariant, rules, bucketBy, clientSide, version }] }`. Archived flags are not included. Rollout weights are checked to sum to 10,000 so a corrupt snapshot is rejected (AS-24).

## State machine (FR-010 – FR-014)

```text
            save(enabled:true)            kill                 archive
 (create) ─► enabled ◄────save(false)────► disabled ──kill──► killed ──restore──► disabled
              │  ▲                          │                  │                     │
              │  └────── save(true) ────────┘                  └─────archive─────────┤
              └──kill──► killed                                disabled ──archive──► archived
```

| From \ command | save enabled:true | save enabled:false | kill | restore | archive |
|---|---|---|---|---|---|
| (none) | create `enabled` | create `disabled` | 404 | 404 | 404 |
| enabled | apply/noop | `disabled` | `killed` | 409 `invalid_transition` | 409 `invalid_transition` |
| disabled | `enabled` | apply/noop | `killed` | 409 `invalid_transition` | `archived` |
| killed | 409 `flag_killed` | apply/noop (stays `killed`) | noop | `disabled` | `archived` |
| archived | 409 `flag_archived` | 409 `flag_archived` | 409 `flag_archived` | 409 `flag_archived`* | noop |

*Restore on an archived flag: `flag_archived` per FR-013 ("cannot be saved, killed or restored"); on `enabled`/`disabled` it is `invalid_transition` (AS-35). Version rules: create needs `expectedVersion: 0`; an unknown key with `expectedVersion > 0` is 404; a stale version with a different definition is `version_conflict`; kill/restore/archive take no version.

## Evaluation structures (in memory)

`byKey: Map<string, SdkFlag>` rebuilt per applied snapshot; `counts: Map<string, number>`; `version: number`; `ready: boolean`. Evaluation never touches a store.
