# Contract: S38 Feature flags

Schemas live in `packages/contracts/src/experimentation/flags.ts` (zod 4, strict objects). Errors are RFC 9457 problem+json; `type` carries the machine code.

## HTTP

| Route | Auth | Body / query | Success | Errors |
|---|---|---|---|---|
| `GET /api/flags` | anonymous allowed | headers `X-Anonymous-Id`, `X-Client-Platform`, edge `country` header + credential | `200 clientFlagsSchema`, `Cache-Control: private, no-store`, `Vary: Authorization, X-Anonymous-Id` | `429` (120/min/principal, per IP for visitors) |
| `GET /api/admin/flags` | ADMIN | `limit` 1–200 (50), `cursor`, `status`, `includeArchived` | `200 flagPageSchema` | 400 `validation_failed`/`invalid_cursor`, 401, 403 |
| `GET /api/admin/flags/:key` | ADMIN | – | `200 flagSchema` | 401, 403, 404 `flag_not_found` |
| `PUT /api/admin/flags/:key` | ADMIN, 30 writes/min | `flagInputSchema` incl. `expectedVersion` ≥ 0, ≤ 256 KiB | `201` + `Location` (create) / `200` (update, no-op) `flagSchema` | 400, 401, 403, 404, 409 `version_conflict` (`currentVersion`) / `flag_killed` / `flag_archived`, 413, 422 `flag_definition_invalid` (`errors:[{path,code}]`) / `flag_limit_reached`, 429 |
| `POST /api/admin/flags/:key/kill` | ADMIN, write limit | – | `204` (idempotent) | 401, 403, 404, 409 `flag_archived`, 429 |
| `POST /api/admin/flags/:key/restore` | ADMIN, write limit | – | `204` | 409 `invalid_transition` (`currentStatus`) / `flag_archived`, 404 |
| `POST /api/admin/flags/:key/archive` | ADMIN, write limit | – | `204` (idempotent) | 409 `invalid_transition`, 404 |
| `GET /api/admin/flags/:key/history` | ADMIN | `limit`, `cursor` | `200 flagAuditPageSchema` (`at desc, id desc`) | 400, 404 |
| `GET /api/admin/flags/stale` | ADMIN | `days` 1–30 (14) | `200 staleFlagsSchema` | 400 |

`/api/admin/flags/stale` is declared before `/api/admin/flags/:key` in the controller. Write verbs on `/history` answer 404/405.

## Schemas (shape summary)

- `flagSchema`: `{key, description, owner, status, enabled, variants[{key,value}], defaultVariant, offVariant, rules[{id, conditions[{attribute, op, values}], variant?|rollout?[{variant, weight}]}], bucketBy, clientSide, expiresAt|null, version, createdAt, updatedAt}`.
- `flagInputSchema`: `flagSchema` without `key`, `status`, `version`, `createdAt`, `updatedAt`; `enabled` is the input boolean; plus `expectedVersion`; unknown properties refused.
- `flagPageSchema`: `{items: flagSchema[], nextCursor: string|null}`.
- `flagAuditPageSchema`: `{items:[{id, flagKey, action, actorId, requestId|null, at, before|null, after}], nextCursor}`.
- `clientFlagsSchema`: `{version, flags: Record<key, {variant, value}>}`.
- `staleFlagsSchema`: `{days, items:[{key, owner, status, expiresAt|null, createdAt, evaluations, expired, reason: 'expired'|'unused'}]}`.
- `flagRulesetSnapshotSchema`: see `data-model.md`.
- `flagChangedEventSchema`: `{eventId, type:'experimentation.flag_changed', version:1, occurredAt, flagKey, action, flagVersion, actorId}`.
- `packages/contracts/src/bff/upstream.ts`: `flagsResponseSchema` becomes an alias of `clientFlagsSchema` (name and `FlagsResponse` type kept).

## Breaking changes (from `questions.md` BREAKING)

`PUT` requires `expectedVersion`; `GET /flags` body is `{version, flags:{key:{variant,value}}}`; lists are pages; `enabled` is derived from `status`; kill is not undone by save; validation answers split 400/422; client context hardened. Only W06 (`packages/web/lib/api/admin.ts`) and the BFF read these today; both are listed in `gaps.md` follow-ups.

## SDK (`@app/domains/experimentation`)

`FlagsClient`: `isEnabled(key, ctx)`, `value(key, ctx, fallback)`, `evaluate(key, ctx) → Evaluation`, `ready`, `version`; synchronous, no I/O, never throws on a bad key. `RequireFlag(key)`. Types `EvalContext`, `FlagValue`, `Evaluation`. `bucketOf(salt, unit)`. `flagChangedEventSchema`. Modules `FlagsSdkModule`, `FlagsAdminModule`, `FlagTopicsModule`. Nothing else.

## Realtime

Topic `flags` (singleton, `TopicRegistry.define`, policy: role `SERVICE` only); payload: the ruleset version.
