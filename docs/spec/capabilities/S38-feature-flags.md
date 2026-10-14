---
id: S38
title: Feature flags and remote config (targeting, percentage rollout, local evaluation, kill switch, audit)
kind: capability
status: draft
depends_on: [S01, S03, S49, S50, S51, S53, S54]
concepts: [problem-json-errors, rate-limit-policy, realtime-topic-stream, job-scheduler-lease, outbox-task-queue, transaction-runner]
models: []
scope:
  - packages/backend/libs/domains/experimentation/api/flags-admin.controller.ts
  - packages/backend/libs/domains/experimentation/api/flags-client.controller.ts
  - packages/backend/libs/domains/experimentation/api/flags.guard.ts
  - packages/backend/libs/domains/experimentation/api/body-size.guard.ts
  - packages/backend/libs/domains/experimentation/api/request-context.ts
  - packages/backend/libs/domains/experimentation/api/realtime-topics.ts
  - packages/backend/libs/domains/experimentation/application/flag-*.ts
  - packages/backend/libs/domains/experimentation/application/flags-*.ts
  - packages/backend/libs/domains/experimentation/application/client-flags.service.ts
  - packages/backend/libs/domains/experimentation/application/eval-context.service.ts
  - packages/backend/libs/domains/experimentation/application/ruleset-*.ts
  - packages/backend/libs/domains/experimentation/domain/bucket.ts
  - packages/backend/libs/domains/experimentation/domain/evaluator.ts
  - packages/backend/libs/domains/experimentation/domain/flag-*.ts
  - packages/backend/libs/domains/experimentation/domain/ports.ts
  - packages/backend/libs/domains/experimentation/infra/sequelize-flag.repository.ts
  - packages/backend/libs/domains/experimentation/infra/redis-*.ts
  - packages/backend/libs/domains/experimentation/infra/flags.jobs.ts
  - packages/backend/libs/domains/experimentation/infra/models/f*.ts
  - packages/backend/libs/domains/experimentation/flags*.module.ts
  - packages/backend/libs/domains/experimentation/rate-limit-policies.ts
  - packages/contracts/src/experimentation/flags.ts
  - packages/backend/libs/common/config/flags-config.ts
  - packages/backend/migrations/20261014090000-flags-lifecycle.js
---
# S38 - Feature flags and remote config (targeting, percentage rollout, local evaluation, kill switch, audit)
## Purpose
A platform admin defines a flag with variants, ordered targeting rules and weighted rollouts, ships it dark and ramps it up. Every backend process holds the whole ruleset in memory and evaluates locally: a flag check is a pure function call, stays correct with the cache and the database down, and converges on the database truth through push, polling and a repair job. Kill is a state nobody undoes by saving; every applied change is audited in the same transaction; browsers get only their own pre-evaluated client-side flags; a route can stay invisible until its flag is on.

## Entry points
- `PUT /api/admin/flags/:key`, `POST /api/admin/flags/:key/kill`, `POST /api/admin/flags/:key/restore`, `POST /api/admin/flags/:key/archive`, `GET /api/admin/flags`, `GET /api/admin/flags/stale`, `GET /api/admin/flags/:key` and `GET /api/admin/flags/:key/history`. [code: packages/backend/libs/domains/experimentation/api/flags-admin.controller.ts#FlagsAdminController]
- `GET /api/flags`, public, the caller's pre-evaluated client-side flags. [code: packages/backend/libs/domains/experimentation/api/flags-client.controller.ts#FlagsClientController]
- `FlagsClient` (`isEnabled`, `value`, `evaluate`, `ready`, `version`), `RequireFlag(key)` and `bucketOf(salt, unit)`, exported from the domain barrel. [code: packages/backend/libs/domains/experimentation/application/flags-client.service.ts#FlagsClient] [code: packages/backend/libs/domains/experimentation/api/flags.guard.ts#RequireFlag] [code: packages/backend/libs/domains/experimentation/domain/bucket.ts#bucketOf]
- Event `experimentation.flag_changed` v1 on `flags.events`; realtime topic `flags` (service role only); job `flags.repair-ruleset`. [code: packages/backend/libs/domains/experimentation/domain/flag-events.ts#FlagChanged] [code: packages/backend/libs/domains/experimentation/api/realtime-topics.ts#FlagTopics] [code: packages/backend/libs/domains/experimentation/infra/flags.jobs.ts#FlagsJobs]

## Rules
- **S38.R-01** Creating a flag with `expectedVersion: 0` MUST answer `201` with `Location` and a body that parses with `flagSchema`, store one flag row, one `create` audit row (`before` null, `after` the stored flag, the actor) and raise the ruleset version by exactly one, and a new flag MUST be `disabled` or `enabled` as submitted. [proof: S38 AS-01] [code: packages/backend/libs/domains/experimentation/application/flag-command.service.ts#FlagCommandService]
- **S38.R-02** A rollout MUST put the configured share of users on a variant (4 to 6 % of 20,000 at 5 %, 45 to 55 % of 2,000 at 50 %), keep each user on the same variant across repeats and restarts, and only add users when widened. [proof: S38 AS-02, S38 AS-03, S38 AS-14] [code: packages/backend/libs/domains/experimentation/domain/evaluator.ts#evaluate]
- **S38.R-03** A save equal in every field to the stored definition MUST answer `200` with the stored flag and write no audit row, no outbox row, no ruleset change and no push, whatever `expectedVersion` it carries; a stale `expectedVersion` with a different definition MUST be `409` `version_conflict` with `currentVersion`. [proof: S38 AS-04, S38 AS-05] [code: packages/backend/libs/domains/experimentation/domain/flag-lifecycle.ts#decide]
- **S38.R-04** Two simultaneous saves with one `expectedVersion`, or two creates of one key, MUST give exactly one success and one `409` `version_conflict`, one audit row and one ruleset increment, because every write locks the single ruleset row and then the flag row. [proof: S38 AS-06, S38 AS-07] [code: packages/backend/libs/domains/experimentation/infra/sequelize-flag.repository.ts#SequelizeFlagRepository]
- **S38.R-05** An update of an unknown key with `expectedVersion` above 0 MUST be `404` `flag_not_found` and persist nothing. [proof: S38 AS-08] [code: packages/backend/libs/domains/experimentation/domain/flag-lifecycle.ts#decide]
- **S38.R-06** A request that breaks the shape (missing field, wrong type, unknown property, bad `expectedVersion`, a path key outside `^[a-z0-9][a-z0-9-]{1,63}$`) MUST be `400` `validation_failed` naming the fields, a body above 256 KiB `413` before validation, and nothing is persisted. [proof: S38 AS-09] [code: packages/backend/libs/domains/experimentation/api/body-size.guard.ts#BodySizeGuard]
- **S38.R-07** Semantic problems of a definition (unknown variant, duplicate keys or ids, weights not summing to 10,000, a rule with both or neither of `variant` and `rollout`, unknown attribute, operator arity, `gte` or `lte` with a non-number, `bucketBy`, an `expiresAt` that is new and not in the future) MUST all be reported together as `422` `flag_definition_invalid` with `errors: [{path, code}]` and nothing persisted. [proof: S38 AS-10] [code: packages/backend/libs/domains/experimentation/domain/flag-validation.ts#validateDefinition]
- **S38.R-08** The limits (20 variants, 50 rules, 10 conditions, 100 values, 4 KiB per variant value, description 500, owner 100) MUST be refused with their own code, and at most 500 non-archived flags MUST exist, enforced under the ruleset lock so concurrent creates cannot exceed it (`422` `flag_limit_reached`, archived flags not counted). [proof: S38 AS-11, S38 AS-12] [code: packages/backend/libs/domains/experimentation/domain/flag-validation.ts#validateDefinition]
- **S38.R-09** Evaluation MUST follow the precedence of status (`killed` and `disabled` serve the off variant), then the first matching rule, then the default, with the operator semantics for present, absent and array-valued attributes, and a rollout without a bucketing unit MUST serve its first slice. [proof: S38 AS-13, S38 AS-16, S38 AS-52] [code: packages/backend/libs/domains/experimentation/domain/evaluator.ts#evaluate]
- **S38.R-10** Different flags MUST bucket independently with one shared hash, `murmur3(salt:unit) mod 10000`, whose reference vectors are pinned. [proof: S38 AS-15] [code: packages/backend/libs/domains/experimentation/domain/bucket.ts#bucketOf]
- **S38.R-11** An unknown or archived key MUST evaluate to `unknown_flag` (never an error): `isEnabled` false, `value` the caller's fallback. [proof: S38 AS-17] [code: packages/backend/libs/domains/experimentation/domain/evaluator.ts#unknownFlag]
- **S38.R-12** With the cache and the database both unreachable at run time an SDK MUST keep answering from its last ruleset with identical results, no store call and no added latency, and stay ready; a failed refresh MUST be counted and keep the ruleset. [proof: S38 AS-18] [code: packages/backend/libs/domains/experimentation/application/flags-client.service.ts#FlagsClient]
- **S38.R-13** An SDK MUST start from the cache, else from the database, never block start-up when neither answers (not ready, `ruleset_unavailable`, caller fallbacks), and retry every 5 seconds until a ruleset loads. [proof: S38 AS-19, S38 AS-20] [code: packages/backend/libs/domains/experimentation/application/flags-client.service.ts#FlagsClient]
- **S38.R-14** A save and a kill MUST reach a running SDK within 1 second by push, and within 35 seconds by polling when the push is lost. [proof: S38 AS-21, S38 AS-22] [code: packages/backend/libs/domains/experimentation/application/flags-client.service.ts#FlagsClient]
- **S38.R-15** An SDK MUST apply a snapshot only when it is valid and strictly newer than the one in use; older, equal and reordered snapshots MUST be ignored and counted, and corrupt ones (not JSON, or failing the snapshot schema) rejected and counted, keeping the version. [proof: S38 AS-23, S38 AS-24] [code: packages/backend/libs/domains/experimentation/application/flags-client.service.ts#FlagsClient]
- **S38.R-16** A refresh MUST read the cache within 500 ms, else the database within 2 seconds, so a slow cache costs at most that and never an evaluation. [proof: S38 AS-27] [code: packages/backend/libs/domains/experimentation/infra/redis-ruleset.source.ts#RedisRulesetSource]
- **S38.R-17** After commit the snapshot MUST be built from the database and published to the cache (TTL one hour, only if newer) and its version pushed, within 500 ms; a failure MUST be counted and never fail or delay the committed write beyond 1.5 seconds. [proof: S38 AS-25] [code: packages/backend/libs/domains/experimentation/application/ruleset-publisher.service.ts#RulesetPublisherService]
- **S38.R-18** The repair job MUST republish when the cache holds no snapshot or an older version than the database, share one run among concurrent callers, keep a TTL on the key, and survive the cache failures it repairs. [proof: S38 AS-26] [code: packages/backend/libs/domains/experimentation/application/ruleset-repair.service.ts#RulesetRepairService]
- **S38.R-19** The ruleset version MUST be stored in the primary database and survive a cache flush, so the next publish after a flush carries the database version plus one. [proof: S38 AS-28] [code: packages/backend/libs/domains/experimentation/infra/sequelize-flag.repository.ts#SequelizeFlagRepository]
- **S38.R-20** Evaluation counts MUST be aggregated per flag in memory, flushed per UTC day (40-day expiry) and at shutdown, kept when a flush fails, and only keys of the ruleset counted. [proof: S38 AS-29] [code: packages/backend/libs/domains/experimentation/infra/redis-eval-counters.ts#RedisEvalCounters]
- **S38.R-21** Kill MUST answer `204`, set `killed` whatever the previous non-archived status, keep the rules, write one `kill` audit row and one outbox event, and turn the flag off in every process within 1 second, staff included. [proof: S38 AS-30] [code: packages/backend/libs/domains/experimentation/application/flag-command.service.ts#FlagCommandService]
- **S38.R-22** A repeated or concurrent kill MUST change nothing further (one audit row, version and ruleset unchanged); a kill of an unknown flag is `404` and of an archived flag `409` `flag_archived`. [proof: S38 AS-31, S38 AS-32] [code: packages/backend/libs/domains/experimentation/domain/flag-lifecycle.ts#decide]
- **S38.R-23** A kill racing a save of `enabled: true` MUST always end `killed`; a save of `enabled: true` on a killed flag MUST be `409` `flag_killed`, and `enabled: false` accepted with the status staying `killed`. [proof: S38 AS-33, S38 AS-34] [code: packages/backend/libs/domains/experimentation/domain/flag-lifecycle.ts#decide]
- **S38.R-24** Restore MUST move `killed` to `disabled` (with a `restore` audit row), never to `enabled`, and answer `409` `invalid_transition` with `currentStatus` from any other state. [proof: S38 AS-35] [code: packages/backend/libs/domains/experimentation/domain/flag-lifecycle.ts#decide]
- **S38.R-25** Archive MUST move `disabled` or `killed` to `archived` (idempotent), remove the flag from the ruleset and the default list, keep its history, reserve its key (`409` `flag_archived` on save or create) and refuse `enabled` with `409` `invalid_transition`. [proof: S38 AS-36] [code: packages/backend/libs/domains/experimentation/domain/flag-lifecycle.ts#decide]
- **S38.R-26** `GET /api/flags` MUST be public and return `{version, flags: {key: {variant, value}}}` for client-side flags in the ruleset only (killed and disabled show their off variant), never rules, rollouts, owners or other flags, with `Cache-Control: private, no-store` and `Vary: Authorization, X-Anonymous-Id`, and the same body for an admin. [proof: S38 AS-37] [code: packages/backend/libs/domains/experimentation/application/client-flags.service.ts#ClientFlagsService]
- **S38.R-27** The client answer MUST be sticky per visitor and per user across devices, and flipping `clientSide` off MUST remove the key within 1 second. [proof: S38 AS-38] [code: packages/backend/libs/domains/experimentation/application/client-flags.service.ts#ClientFlagsService]
- **S38.R-28** The evaluation context MUST come only from the authenticated principal and from a shop the caller is a member of; a client-sent shop, user id, role or e-mail MUST be ignored. [proof: S38 AS-39] [code: packages/backend/libs/domains/experimentation/application/eval-context.service.ts#EvalContextService]
- **S38.R-29** An anonymous id MUST be 8 to 64 characters of `[A-Za-z0-9_-]` to be used (else the rollout's first slice is served), the platform one of `web`, `ios`, `android`, and the country only with the edge credential. [proof: S38 AS-40, S38 AS-41] [code: packages/backend/libs/domains/experimentation/api/request-context.ts#factsFromRequest]
- **S38.R-30** The client endpoint MUST be limited to 120 requests a minute per principal (per address for visitors) and the admin writes to 30 a minute per admin, `429` with `Retry-After`, reads not counted. [proof: S38 AS-42, S38 AS-55] [code: packages/backend/libs/domains/experimentation/rate-limit-policies.ts#flagsRatePolicies]
- **S38.R-31** The history MUST list audit rows newest first (`at`, then `id`), keyset-paged by a signed cursor bound to the flag (limit 1 to 200, default 50), with `before`, `after`, actor and request id; a forged or foreign cursor is `400` `invalid_cursor`. [proof: S38 AS-43, S38 AS-44] [code: packages/backend/libs/domains/experimentation/domain/flag-cursor.ts#decodeCursor]
- **S38.R-32** An applied change MUST write the flag, the new ruleset version, one audit row and one `flag_changed` outbox event in one transaction, so a failing audit write rolls everything back (a generic `500`, no event, no push); audit rows are append-only, and a no-op writes no event. [proof: S38 AS-45, S38 AS-46, S38 AS-47] [code: packages/backend/libs/domains/experimentation/application/flag-command.service.ts#FlagCommandService]
- **S38.R-33** The stale report MUST list non-archived flags that are expired or older than `days` days with no evaluation in that window (`days` 1 to 30, default 14, else `400`), and an expiry MUST never change evaluation. [proof: S38 AS-48, S38 AS-49, S38 AS-50] [code: packages/backend/libs/domains/experimentation/application/flag-query.service.ts#FlagQueryService]
- **S38.R-34** A gated route MUST answer exactly like an undefined route (`404`, same body but its URL) unless its flag evaluates to `true` for the caller, a shop allowlist included, and a kill MUST close it within 1 second. [proof: S38 AS-51, S38 AS-52] [code: packages/backend/libs/domains/experimentation/api/flags.guard.ts#FlagGuard]
- **S38.R-35** Admin routes MUST answer `401` without credentials and `403` with identical bodies for existing and unknown keys to any other role, changing nothing. [proof: S38 AS-53, S38 AS-54] [code: packages/backend/libs/domains/experimentation/api/flags-admin.controller.ts#FlagsAdminController]
- **S38.R-36** The admin list MUST be a keyset page ordered by key (`limit` 1 to 200, default 50) with a `status` filter and `includeArchived`, and `GET /api/admin/flags/:key` the explicit `flagSchema` shape or `404`. [proof: S38 AS-56] [code: packages/backend/libs/domains/experimentation/application/flag-query.service.ts#FlagQueryService]
- **S38.R-37** The domain MUST own its tables (`FeatureFlag`, `FlagAudit`, `FlagRuleset`), reach no other domain's tables, export only the SDK, the gate, the modules and the event contract, and the real core, worker and gateway applications MUST start with it wired. [proof: S38 AS-57] [code: packages/backend/libs/domains/experimentation/flags-stores.module.ts#FlagsStoresModule]
- **S38.R-38** The metrics `flags_evaluations_total{flag,reason}` (unknown keys labelled `unknown`), `flags_ruleset_version`, `flags_ruleset_age_seconds`, `flags_ruleset_rejected_total`, `flags_publish_failures_total` and `flags_refresh_failures_total` MUST match what happened, and the one admin log line per applied change MUST carry the request id, actor, flag key, action and flag version and never a body, a variant value or a header. [proof: S38 AS-58] [code: packages/backend/libs/domains/experimentation/application/flags-metrics.ts#flagsEvaluationsTotal]
- **S38.R-39** The flags migration MUST be expand-only and idempotent: it adds `status` (backfilled from `enabled`, never `killed`), `createdAt`, `requestId` and the `FlagRuleset` row, and keeps `enabled` readable for the previous release. [proof: none] [code: packages/backend/migrations/20261014090000-flags-lifecycle.js]

## Behaviors
- **S38.B-01** Given an admin who ships `new-checkout` dark and releases it to 5 % of users, when they widen it to 20 %, then every user who had it still has it. [proof: S38 AS-03]
- **S38.B-02** Given two admins saving the same flag from the same version, then one save wins and the other is told to reload. [proof: S38 AS-06]
- **S38.B-03** Given an engineer who kills a misbehaving feature, then every service serves the off variant within a second and a later save cannot turn it back on. [proof: S38 AS-34]
- **S38.B-04** Given the cache flushed and the push lost, then services still converge on the database version within 35 seconds and the repair job refills the cache. [proof: S38 AS-26]
- **S38.B-05** Given a gated route whose flag is off, then a visitor sees the same `404` as for a route that does not exist. [proof: S38 AS-51]

## Lifecycles
A flag is `enabled` or `disabled` (by save), `killed` (by kill; only restore leaves it, into `disabled`) or `archived` (final, from `disabled` or `killed`; its key stays reserved). The ruleset version rises by one for every applied change and never for a no-op.

## Owns
- PostgreSQL tables `FeatureFlag`, `FlagAudit` (append-only) and `FlagRuleset` (the single version row).
- Redis keys `flags:ruleset` (snapshot, one hour) and `flags:evals:<day>` (40 days), realtime topic `flags`, event topic `flags.events`, job `flags.repair-ruleset`, rate-limit policies `flags.admin.write` and `flags.client.read`.
- Configuration key `flags_edge_secret` (optional).

## Decisions
- Postgres is the system of record and Redis only a derived cache: the ruleset is a few hundred rows written at most 30 times a minute, and the version, the count cap and the kill need one store.
- Every write locks the ruleset row first, then the flag row, so versions strictly increase, the cap is exact and writers cannot deadlock.
- The SDK reads time from the injected clock and a one-second ticker, so a spec that moves the clock moves every interval.
- `version_conflict` and `invalid_transition` are shared problem names registered first by other capabilities; S38 raises them with its own detail.

## Known gaps
- The capacity criteria (SC-001 evaluator speed, SC-008 client endpoint p99 at 500 flags) have no automated proof (listed in `specs/UNVERIFIED.md`).
- A start of the real processes with the Redis cache stopped is a manual smoke; the SDK-level behaviour is proven.
- The admin console (W06) still shows the first page of 50 flags and sends no kill, restore or archive beyond kill.
