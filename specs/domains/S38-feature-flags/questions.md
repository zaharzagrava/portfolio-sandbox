# Questions and defaults: S38 Feature flags and remote config

No clarification was requested (unattended run). Each line is a choice made by the decision policy (production-grade, notes and constitution first). Sorted by impact: BREAKING, then CONTRACT, then LOCAL. The Interview-Prep notes were read from `.specify/memory/Interview-Prep/10-System-Design/09-data-and-infrastructure.md` §38 and `docs/showcase/sections/SD-38-feature-flags.md`; the original at `~/workspace/notes/Interview-Prep/` was outside the session's allowed directories. No spec written so far requires anything from S38 (searched `specs/domains`, `specs/web`, `specs/journeys` for `S38` and `experimentation`: only D-15 mentions in S10–S15 gaps and S35's reference to S39).

## BREAKING

- [BREAKING] `PUT /api/admin/flags/:key` requires `expectedVersion` (0 = create); a stale one with a different definition is `409 version_conflict`; an equal definition is a no-op `200` → optimistic concurrency, replay-safe → two admins currently overwrite each other silently (last writer wins) → `flags-admin.service.ts:37-72`; `packages/web/lib/api/admin.ts:37`.
- [BREAKING] Flag `status` (`enabled|disabled|killed|archived`) replaces the bare `enabled` boolean; kill is a distinct state that a save cannot undo (`409 flag_killed`); new `POST …/restore` (killed → disabled only) and `POST …/archive`; kill idempotent; archived keys reserved → a kill that any later save can silently revert is not a kill switch → `flags-admin.service.ts:74-86`.
- [BREAKING] Create answers `201` with `Location` and the flag; update `200`; both return `flagSchema` (explicit DTO, no internal columns, `createdAt` added) → V.1, V.2 → `flags.controller.ts:57-60`, `flags-admin.service.ts:33-35`.
- [BREAKING] Validation split: shape errors `400 validation_failed`, semantic errors `422 flag_definition_invalid` with `errors: [{path, code}]` (all at once), limits (20 variants, 50 rules, 10 conditions, 100 values, 4 KiB value, 500 flags), closed attribute set, operator arity, exactly one of `variant`/`rollout` per rule (today `variant` silently wins), `expiresAt` must be future, 256 KiB body → V.4, abuse bound → `evaluator.ts:95,111-128`, `flags.controller.ts:10-22`.
- [BREAKING] `GET /api/flags` returns `{version, flags: {key: {variant, value}}}` (today `{key: value}`) with `Cache-Control: private, no-store`, `Vary`, and a 120/min rate limit → clients need the variant to log exposures to S39; the response is per-visitor and must not be cached by a shared cache → `flags.controller.ts:30-36`.
- [BREAKING] Client-supplied context is hardened: shop, user, role and email only from the authenticated principal and the verified shop; anonymous id must be 8–64 `[A-Za-z0-9_-]` else ignored; `platform` enum; `country` only with the edge credential → targeting inputs must not be spoofable (IV.7, cross-tenant) → `domain/flags-context.ts:10-15`.
- [BREAKING] List and history use keyset pages `{items, nextCursor}` (`limit` 1–200, default 50; flags by `key`, history by `at desc, id desc`) instead of a bare array and `LIMIT 100`; archived flags hidden by default → III.10 → `flags-admin.service.ts:33-35,94-96`.
- [BREAKING] The ruleset version is allocated in the primary database in the writing transaction (not by a cache `INCR`), the snapshot key has a TTL, publication is time-boxed and never fails the write, a repair job republishes a missing or old snapshot, and SDKs fall back to the database when the cache fails → a cache flush or a lost publish must not strand SDKs → `flags-admin.service.ts:16-24,111-117`; the e2e workaround at `flags.e2e-spec.ts:44-47`.
- [BREAKING] SDK validates every snapshot with a schema, applies only strictly newer versions, counts ignored and rejected ones, polls with jitter, has timeouts (cache 500 ms, database 2 s), exposes `ready`, and a cold start with both stores down no longer fails boot (serves fallbacks, retries every 5 s) → IV.4–IV.8, VIII.3 → `infra/flags.client.ts:50-61,89-102`.
- [BREAKING] `Evaluation` gains reasons `killed` and `ruleset_unavailable` and the field `flagVersion`; the unknown-flag result carries the asked key (today `'?'`) → exposure logging and diagnostics → `evaluator.ts:46,89`.
- [BREAKING] A save, kill, restore or archive that changes nothing writes no audit row, no event and no version bump (today a repeat kill and an equal save both do) → audit noise hides real changes → `flags-admin.service.ts:50,74-86`.
- [BREAKING] Audit `actorId` becomes `NOT NULL`, rows gain `requestId`, `before`/`after` are the flag response shape (no raw columns), and an `experimentation.flag_changed` outbox event is committed with every applied change → traceability; deploy markers → migration `20261001310000`, `flags-admin.service.ts:121-127`.
- [BREAKING] Stale report: only non-archived flags that are expired, or older than the window with no evaluations; `days` 1–30; response `{days, items: [{key, owner, status, expiresAt, createdAt, evaluations, expired, reason}]}`; flush failure keeps counts → today new flags are reported as stale and `days` is unbounded → `flags-admin.service.ts:99-109`, `flags.client.ts:109-117`.
- [BREAKING] Admin writes rate limited to 30/min per admin (new profile `flags.admin.write`) → a flag write is a production write → no limit exists.
- [BREAKING] Gated routes answer a `404` identical to an undefined route (problem+json, only `instance` and `requestId` differ) → no probing for dark features → `flags.guard.ts:14-22`.
- [BREAKING] The two sibling Nest modules `FlagsSdkModule` and `FlagsAdminModule` stay, but the barrel now exports `FlagsClient`, `RequireFlag`, `EvalContext`, `FlagValue`, `Evaluation`, `bucketOf`, `flagChangedEventSchema` → X.4; today other domains would have to deep-import → `index.ts`.
- [BREAKING] Existing `flags.e2e-spec.ts` (service-level admin calls, one HTTP test) is replaced by the six files in `test-plan.md` → VII.2, VII.3 → `flags.e2e-spec.ts`.

## CONTRACT

- [CONTRACT] S39 must call `bucketOf(salt, unit)` with the experiment id as `salt` and log exposures as `name: 'exposure'`, `props: {flag_key, variant, flag_version}` → P0811 (one assignment hash); S39's spec does not exist yet; if it needs another shape it must say so.
- [CONTRACT] W06 (admin console) consumes the admin API of `spec.md` (`expectedVersion`, `status`, restore, archive, history pages, stale report) and the `flagSchema`/`flagInputSchema` contracts; W06's spec does not exist yet and today's console sends no `expectedVersion` → the console must follow the new shape.
- [CONTRACT] The BFF or Next.js server reaches `GET /api/flags` by R2: it forwards the session and `X-Anonymous-Id`, sets the edge's `country` header with the edge credential, and never caches the response in a shared cache → the response is per-visitor; W-capabilities that show flagged UI must follow this and log exposures through S39.
- [CONTRACT] `plan` targeting: callers (S18's consumers, S10, S11, S20, S36) put `plan` in the `EvalContext` themselves, using S18's entitlement export; S38 does not call S18 → keeps S38 a leaf in the domain graph (D-15 stays unaffected). If a capability wants the browser endpoint to target on `plan`, it must say so; `GET /api/flags` today supports only attributes that the session carries.
- [CONTRACT] `shopId` for the endpoint and the gate must be the shop verified by S03's membership check; S03 does not yet say whether a verified active shop is set on `GET /api/flags` (a public route) → default: only when a session and a verified `X-Shop-Id` membership are both present.
- [CONTRACT] `experimentation.flag_changed` v1 is published with no consumer today → no capability needs it yet; it exists for ops dashboards and deploy markers and costs one outbox row per change.
- [CONTRACT] The `flags` realtime topic stays service-only (`SERVICE` role) and carries only the ruleset version → keeps IV.3: nothing that must be delivered rides on pub/sub.

## LOCAL

- [LOCAL] Transport for services stays the existing realtime channel `flags`, not browser SSE → the notes say "SSE or polling"; services need a version nudge, and polling plus repair guarantee delivery.
- [LOCAL] 10,000 buckets (basis points), `bucketBy` limited to `userId`/`shopId` → SD-38 and worked example 2 use `% 10000`; one summary line uses `% 100`.
- [LOCAL] Archived flags leave the ruleset and evaluate as unknown (caller's fallback) → code referencing a deleted flag gets its coded default.
- [LOCAL] Archive is soft and the key is reserved forever → audit history stays unambiguous; no hard delete route.
- [LOCAL] Expiry is advisory (reported, never enforced) → silent behaviour change at a date can cause an outage.
- [LOCAL] Rollout with no bucketing unit serves its first slice → kept from the code; conservative, usually the control.
- [LOCAL] Anonymous-to-user stickiness across sign-in is not preserved → documented; S39 owns experiment continuity.
- [LOCAL] Evaluation counters stay approximate (in-memory, flushed every 30 s, 40-day TTL).
- [LOCAL] Variant `key` format `^[a-z0-9][a-z0-9_-]{0,31}$`, rule id `^[a-z0-9-]{1,32}$` → bounded identifiers for logs and metrics.
- [LOCAL] The `flag` metric label is bounded by the 500-flag cap → safe cardinality.
- [LOCAL] Repair job interval 30 s, snapshot TTL 1 h → refreshed by the repair job; short enough to heal, long enough to survive its own outage.
