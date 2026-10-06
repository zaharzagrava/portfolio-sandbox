# Feature Specification: S38 — Feature Flags and Remote Config (targeting, % rollout, local evaluation, kill switches, audit)

**Feature Branch**: none (spec directory `specs/domains/S38-feature-flags`)

**Created**: 2026-10-05

**Status**: Draft

**Input**: Capability S38 of `scripts/sdd/capabilities.tsv` (domain `experimentation`). Sources: `docs/showcase/sections/SD-38-feature-flags.md` and `10-System-Design/09-data-and-infrastructure.md` §38, read from the Interview-Prep copy at `.specify/memory/Interview-Prep/` (the notes win over the code; the original at `~/workspace/notes/Interview-Prep/` was outside the session's allowed directories). Supporting notes: `10-System-Design/02-worked-examples.md` Example 2 (assignment hashing) and `08-DevOps-Cloud/01` §5 (decouple deploy from release). Pattern rows: P0802 (deployment strategies: canary and flags) and P0811 (deterministic hash assignment shared with analytics) of `docs/architecture/pattern-map.md`.

## Scope

**In scope** (everything a platform admin, a backend service, a browser client and an on-call engineer can observe of flags):

- Flag definitions: variants (boolean, string, number or JSON values), ordered targeting rules over user, shop and request attributes, weighted percentage rollouts, a default and an off variant, an owner, an optional expiry. Definition validation and limits.
- Flag lifecycle: create, update, kill, restore, archive; optimistic concurrency; legal and illegal transitions.
- Evaluation: a pure, in-memory evaluation function; the local-evaluation SDK that every backend process embeds; consistent, sticky, widening-only percentage rollouts.
- Propagation: how a change reaches every running process (push, polling fallback, repair), and how processes behave when stores are down or send bad data.
- The pre-evaluated client flags endpoint for browsers and apps, and the route gate that makes a route look absent while its flag is off.
- Audit: an append-only history of every change, readable by admins.
- Flag hygiene: expiry and the stale-flag report (flags are tech debt).
- Operating the capability: limits, rate limits, access control, observability, ownership of its stores.

**Out of scope** (owned elsewhere; named so nothing is built twice):

- The analytics event stream, exposure events, experiment definitions, assignment of experiment variants, SRM and results → **S39** (same domain). This capability only shares the bucketing hash with S39 (FR-024) and returns the variant needed to log an exposure (FR-040).
- The admin console screens (list, edit, kill, audit view) → **W06**, which consumes the admin API of this spec.
- Subscription plans and entitlements (the source of a shop's `plan`) → **S18**. This capability targets on a `plan` attribute that the calling service supplies; it never looks a plan up.
- Identity, sessions and roles → **S01**. Shop membership and the verified active shop → **S03**.
- The browser transport for pushing flag changes to web clients. Browsers re-fetch the client endpoint; they are not pushed to.
- Gradual infrastructure rollouts (canary or blue/green deploys) → ops. This capability supplies the in-code half of progressive delivery: ship dark, ramp, kill (P0802).

## User Scenarios & Testing *(mandatory)*

### User Story 1 — An admin ships a feature dark and ramps it up (Priority: P1)

A platform admin defines `new-checkout` while the code is already deployed, keeps it off for everyone, enables it for staff, releases it to 5% of buyers, widens it to 20% and then 100%. Every buyer keeps the same experience while the percentage grows. Two admins editing at once cannot overwrite each other silently. Invalid definitions are refused with a precise list of problems.

**Why this priority**: it is the reason flags exist — separating deploy from release (08/01 §5).

**Independent Test**: create → ramp → read back, with the evaluation function and the stored definition; no other capability needed.

**Acceptance Scenarios**:

1. **AS-01** — **Given** no flag `new-checkout` and an admin, **When** they `PUT /api/admin/flags/new-checkout` with `expectedVersion: 0`, `enabled: false`, variants `off=false` and `on=true`, `defaultVariant: "off"`, `offVariant: "off"`, `bucketBy: "userId"`, `owner: "checkout-team"` and one rollout rule `5%/95%`, **Then** `201` with a `Location` header `/api/admin/flags/new-checkout`; the body parses with the contracts schema `flagSchema` with `status: "disabled"`, `version: 1`, `createdAt` and `updatedAt`; exactly one flag row exists; exactly one audit row `create` exists with `before: null`, `after` equal to the stored definition and `actorId` the admin's id; the published ruleset version rose by exactly 1; evaluation of the flag for any user returns the off variant.
2. **AS-02** — **Given** AS-01, **When** the admin saves the same flag with `expectedVersion: 1`, `enabled: true` and a `5%` rollout, **Then** `200`, `status: "enabled"`, `version: 2`; one new audit row `update` whose `before` is version 1 and `after` is version 2; of 20,000 distinct user ids between 4% and 6% evaluate to `on`, and each of them evaluates to `on` on 100 repeated calls and after a restart of the evaluating process.
3. **AS-03** — **Given** the same flag at 5% and at 20%, **When** 20,000 user ids are evaluated at both settings, **Then** every user that is `on` at 5% is `on` at 20% (widening only adds users); a user never flips back and forth as the weight grows in steps of 1%.
4. **AS-04** — **Given** a flag at version 2, **When** an admin saves a definition equal in every field to the stored one (with `expectedVersion: 2`, or any older version), **Then** `200` with the stored flag unchanged (`version` still 2, `updatedAt` unchanged); no audit row, no outbox row, no ruleset version bump and no push happen. This is the safe replay of a save whose response was lost.
5. **AS-05** — **Given** a flag at version 2, **When** an admin saves a different definition with `expectedVersion: 1`, **Then** `409` problem `version_conflict` carrying `currentVersion: 2`; nothing changes (flag row, audit, ruleset version).
6. **AS-06** — **Given** a flag at version 2 and two admins, **When** both save different definitions with `expectedVersion: 2` at the same moment (`Promise.all`), **Then** exactly one `200` (version 3) and one `409 version_conflict`; exactly one new audit row `update`; the ruleset version rose by exactly 1; the stored definition is the winner's.
7. **AS-07** — **Given** no flag `x-flag`, **When** two admins create it with `expectedVersion: 0` at the same moment, **Then** exactly one `201` and one `409 version_conflict` (`currentVersion: 1`); exactly one flag row and one audit row `create`.
8. **AS-08** — **Given** no flag `ghost`, **When** an admin saves it with `expectedVersion: 3`, **Then** `404 flag_not_found`; nothing is persisted.
9. **AS-09** — **Given** admin requests that break the request shape (missing `enabled`, `variants` not an array, an unknown extra property, `expectedVersion` missing or negative or not an integer, a body above 256 KiB, a path key that is not `^[a-z0-9][a-z0-9-]{1,63}$`), **When** each is sent, **Then** `400 validation_failed` (`413` for the oversized body), a problem+json body with an `errors` list naming each offending field; nothing is persisted and the ruleset version is unchanged.
10. **AS-10** — **Given** syntactically valid requests whose definitions are semantically wrong (an unknown `defaultVariant`, `offVariant` or rule variant; rollout weights that do not sum to 10,000; a negative or non-integer weight; duplicate variant keys; duplicate rule ids; a rule with both `variant` and `rollout` or with neither; a rollout naming a variant twice; an unknown attribute; an operator with the wrong number of values; `gte` or `lte` with a non-number; `bucketBy` outside `userId`/`shopId`; `expiresAt` that is not in the future), **When** each is sent, **Then** `422 flag_definition_invalid` with `errors: [{path, code}]` listing every problem found in one response (for example `rules[0].rollout` / `weights_sum_invalid` with the actual sum); nothing is persisted.
11. **AS-11** — **Given** definitions that exceed a limit (FR-006: 21 variants, 51 rules, 11 conditions in a rule, 101 values in a condition, a variant value above 4 KiB serialised, a description above 500 characters, an owner above 100 characters), **When** each is sent, **Then** `422 flag_definition_invalid` with the matching limit code (`too_many_variants`, `too_many_rules`, `too_many_conditions`, `too_many_values`, `value_too_large`, `description_too_long`, `owner_too_long`); nothing is persisted.
12. **AS-12** — **Given** 499 non-archived flags, **When** two admins create two different new flags at the same moment, **Then** exactly one `201` and one `422 flag_limit_reached`, and exactly 500 non-archived flags exist; a 501st create answers `422 flag_limit_reached`; archived flags do not count.

---

### User Story 2 — Services evaluate flags locally, always (Priority: P1)

Every backend process holds the whole ruleset in memory and evaluates a flag in microseconds without any network call. A change reaches every process within a second by push, within half a minute by polling if the push is lost, and a process whose stores are down keeps serving the last ruleset it had.

**Why this priority**: a flag service that adds latency or a failure mode to every request would be worse than no flags (09 §38).

**Independent Test**: start the SDK against the real stores, change a flag through the admin API, observe the SDK; then break the stores and observe it keep answering.

**Acceptance Scenarios**:

1. **AS-13** — **Given** the flag evaluation function and the full rule table, **When** evaluated, **Then** the results are exactly those of FR-020 – FR-023 for every case in the table: status `disabled` → off variant with reason `off`; status `killed` → off variant with reason `killed`; the first matching rule wins even when a later rule would also match; all conditions of a rule must hold; no match → default variant with reason `default`; and for each operator, each of present, absent and array-valued attributes (FR-021).
2. **AS-14** — **Given** a flag at `percent = 50` and 2,000 user ids, **When** they are evaluated by the SDK, **Then** between 45% and 55% are `on`; **When** the SDK process is replaced by a fresh one that loads the ruleset from the stores, **Then** every user gets the same variant as before.
3. **AS-15** — **Given** two flags with identical rollouts, **When** 20,000 user ids are evaluated against both, **Then** the users in the same bucket of both flags number fewer than 20 (independent assignment); and the hash matches the reference vectors (`""` → 0, `"hello"` → 613153351, the pangram → `0x2e4ff723`).
4. **AS-16** — **Given** a flag with a rollout rule and no bucketing unit (anonymous without an id; or `bucketBy: "shopId"` and no shop), **When** it is evaluated, **Then** the rule serves the first variant of its rollout with reason `rollout`, deterministically, and no error is raised.
5. **AS-17** — **Given** no flag `does-not-exist` and an archived flag `old-flag`, **When** the SDK is asked `value(key, ctx, "fallback")`, `isEnabled(key, ctx)` and `evaluate(key, ctx)`, **Then** `value` returns `"fallback"`, `isEnabled` returns `false`, and `evaluate` returns `reason: "unknown_flag"` with the asked key in `key`.
6. **AS-18** — **Given** a running SDK with a loaded ruleset, **When** the shared cache and the primary database both become unreachable, **Then** 10,000 evaluations return exactly the same results as before, none of them makes a network call (spies on both clients record zero calls), and the process stays live and ready.
7. **AS-19** — **Given** a process starting while the cache is empty and the primary database holds flags, **When** the SDK starts, **Then** it loads the ruleset from the database and reports `ready`; its version equals the database ruleset version.
8. **AS-20** — **Given** a process starting while the cache and the database are both unreachable, **When** the SDK starts, **Then** the process still starts and stays ready (probes unaffected), `ready` is false, every `value(key, ctx, fallback)` returns the fallback and `evaluate` returns `reason: "ruleset_unavailable"`; **When** the stores return, **Then** the SDK loads a ruleset within 5 seconds without a restart.
9. **AS-21** — **Given** a connected SDK, **When** an admin saves or kills a flag, **Then** the SDK applies the new version within 1 second (push), and `GET /api/flags` and server-side checks reflect it.
10. **AS-22** — **Given** the push channel drops every message, **When** an admin saves a flag, **Then** the SDK applies the new version at its next poll, at most 30 seconds plus jitter (≤ 5 s) after the change (fake clock advanced).
11. **AS-23** — **Given** an SDK at ruleset version 7, **When** it is handed a snapshot of version 6, then version 7 again, then version 7 a second time (stale poll, duplicate push, reordered push), **Then** it stays at version 7 with its evaluations unchanged, and each ignored snapshot is counted; **When** it is handed version 8, **Then** it applies it.
12. **AS-24** — **Given** an SDK at version 7, **When** the cache serves a snapshot that is not valid JSON, or valid JSON that fails the snapshot schema (a flag with a rollout summing to 9,999, an unknown status), **Then** the SDK keeps version 7, increments `flags_ruleset_rejected_total`, logs one warning without the payload, and applies the next valid snapshot.
13. **AS-25** — **Given** the cache is unavailable, **When** an admin saves a flag, **Then** the write answers `200` within 1.5 seconds (publication has a 500 ms timeout and never delays or fails a committed write), the flag row, the audit row and the ruleset version are committed, `flags_publish_failures_total` rises by 1, and every SDK reads the database snapshot at its next poll and applies the new version.
14. **AS-26** — **Given** the cache holds no snapshot or one older than the database ruleset version (a lost publication, a cache flush), **When** the repair job runs on two replicas at the same moment, **Then** exactly one republishes (single run), the cache holds the database version afterwards, and the snapshot key has a time to live; the repair needs no admin action.
15. **AS-27** — **Given** a cache that answers slower than the 500 ms refresh timeout, **When** the SDK refreshes, **Then** the refresh gives up after 500 ms, reads the database (timeout 2 s), applies the newer version if there is one, and evaluations made during the refresh keep their usual latency.
16. **AS-28** — **Given** the cache was flushed (the cache no longer knows any version counter), **When** an admin saves a flag, **Then** the published version is the database ruleset version plus 1, strictly greater than every version published before, and SDKs apply it.
17. **AS-29** — **Given** an SDK that has evaluated flag `a` three times and flag `b` once on the frozen UTC day D, **When** its 30-second flush runs, **Then** the evaluation counter of day D for `a` rose by 3 and for `b` by 1; **Given** the flush fails, **Then** evaluations are unaffected, the counts are kept, and the next successful flush adds them; **Given** a graceful shutdown, **Then** the counts are flushed before the connections close, and the timers do not keep the process alive.

---

### User Story 3 — On-call engineers kill a misbehaving feature in one call (Priority: P1)

When the LLM assistant costs spike or the new checkout fails, an admin turns the flag off everywhere with one call, regardless of its targeting. Nobody can accidentally switch it back on by saving the flag. Restoring is a deliberate second step.

**Why this priority**: the kill switch is the safety net of every release.

**Independent Test**: kill a flag with active rules and rollouts and observe every evaluation return the off variant within a second; then try to enable it.

**Acceptance Scenarios**:

1. **AS-30** — **Given** an enabled flag with a staff rule (`email_domain in [marketplace.dev]` → `on`) and a 50% rollout, **When** an admin calls `POST /api/admin/flags/new-checkout/kill`, **Then** `204`; the flag row has `status: killed` and `version` +1; one audit row `kill` with `before` and `after`; the rules and rollouts are retained unchanged; the ruleset is published; within 1 second every evaluation, including that of a staff user, returns the off variant with reason `killed`; an outbox row `experimentation.flag_changed` exists.
2. **AS-31** — **Given** a killed flag, **When** an admin calls kill again, or two admins call it at once, **Then** every call answers `204`; the flag version, the audit rows (still exactly one `kill`), the outbox rows and the ruleset version are unchanged by the repeats.
3. **AS-32** — **Given** no flag `ghost`, **When** kill is called, **Then** `404 flag_not_found`; **Given** an archived flag, **Then** `409 flag_archived`.
4. **AS-33** — **Given** an enabled flag at version 4, **When** a kill and a save with `enabled: true`, `expectedVersion: 4` arrive at the same moment (`Promise.all`), **Then** the final status is `killed` in every interleaving; the save either answers `200` and is followed by the kill, or answers `409 flag_killed`; the flag is never `enabled` after both finished; the audit rows match the applied changes one to one.
5. **AS-34** — **Given** a killed flag, **When** an admin saves it with `enabled: true`, **Then** `409 flag_killed` and nothing changes; **When** they save other edits with `enabled: false`, **Then** `200`, the status stays `killed`, and the audit row is `update`.
6. **AS-35** — **Given** a killed flag, **When** an admin calls `POST /api/admin/flags/:key/restore`, **Then** `204`, `status: disabled` (still off for everyone), version +1, one audit row `restore`; a later save with `enabled: true` and the current `expectedVersion` makes it `enabled`. **Given** a flag that is `enabled`, `disabled` or `archived`, **When** restore is called, **Then** `409 invalid_transition` with `currentStatus` in the problem, and nothing changes.
7. **AS-36** — **Given** a `disabled` or `killed` flag, **When** an admin calls `POST /api/admin/flags/:key/archive`, **Then** `204`, `status: archived`, one audit row `archive`; the flag leaves the ruleset (SDK evaluation returns `unknown_flag`, FR-025) and the default list; it appears when `includeArchived=true`; its history stays readable; calling archive again answers `204` with no new audit row. **Given** an `enabled` flag, **Then** `409 invalid_transition`. **Given** an archived flag, **When** an admin saves it or creates a flag with its key, **Then** `409 flag_archived` (an archived key is reserved forever so history stays unambiguous).

---

### User Story 4 — Browsers get only their own pre-evaluated flags (Priority: P1)

The storefront asks once per page load which client-side flags are on for the visitor. It receives results, never rules, and nobody can make the answer depend on another shop or role by sending headers.

**Why this priority**: browsers must never see targeting rules (09 §38), and spoofed context would leak or unlock features.

**Independent Test**: call the endpoint anonymously and as a signed-in user and compare with the definitions.

**Acceptance Scenarios**:

1. **AS-37** — **Given** flags `web-new-header` (client-side, 100%), `server-only` (not client-side, 100%) and a killed client-side flag `web-promo`, **When** a visitor without credentials calls `GET /api/flags` with `X-Anonymous-Id: anon-visitor-01`, **Then** `200` (the endpoint is public), the body parses with `clientFlagsSchema` and equals `{version, flags: {"web-new-header": {variant: "on", value: true}, "web-promo": {variant: "off", value: false}}}`; the response has `Cache-Control: private, no-store` and `Vary: Authorization, X-Anonymous-Id`; the serialised body contains none of `rules`, `rollout`, `owner`, `description`, `server-only`; an admin calling it gets the same shape and the same keys.
2. **AS-38** — **Given** a client-side 30% rollout, **When** the same anonymous id calls twice, and when the same signed-in user calls from two devices, **Then** each gets identical results both times; **When** a flag is changed from client-side to server-only, **Then** it disappears from the next response (after the SDK applies the version, ≤ 1 s).
3. **AS-39** — **Given** a signed-in user who is not a member of shop S and a flag targeting `shopId in [S]`, **When** they call `GET /api/flags` with `X-Shop-Id: S`, `?shopId=S`, `X-User-Id: <other user>` and `X-User-Role: ADMIN`, **Then** every one of those is ignored: the response equals the one sent without them (S-targeted variant not served); **Given** a member of shop S whose session carries S as the verified active shop, **Then** the S-targeted variant is served.
4. **AS-40** — **Given** an anonymous id that is shorter than 8 or longer than 64 characters, or has a character outside `[A-Za-z0-9_-]`, **When** the endpoint is called, **Then** `200`; the id is treated as absent: rollouts serve their first variant (AS-16) and nothing in the body echoes the id.
5. **AS-41** — **Given** a rule `country in [DE]` and a rule `platform eq ios`, **When** the endpoint is called with the edge-provided country header `DE` and `X-Client-Platform: ios`, **Then** both rules match; **When** the platform is `toaster` (outside `web`, `ios`, `android`), **Then** it is ignored and the rule does not match; a country header not set by the trusted edge (no edge credential, FR-044) is ignored.
6. **AS-42** — **Given** a limit of 120 requests per minute per principal (anonymous: per IP address), **When** the 121st request arrives within the minute, **Then** `429` problem+json with `Retry-After`; the first 120 answered `200`.

---

### User Story 5 — Every change is auditable (Priority: P2)

Admins see who changed what and when, with the before and after of every change, including kills, and can page through long histories. Audit rows cannot be edited or deleted through the product.

**Why this priority**: a flag change is a production change; auditability is a requirement of the notes ("admin UI and audit log").

**Independent Test**: make a series of changes and read the history.

**Acceptance Scenarios**:

1. **AS-43** — **Given** a flag created, updated and killed by two admins, **When** an admin calls `GET /api/admin/flags/:key/history`, **Then** `200 {items, nextCursor: null}` with items newest first `[kill, update, create]`, each with `id`, `action`, `actorId`, `at`, `requestId`, `before` (null for create) and `after`, parsing with `flagAuditPageSchema`.
2. **AS-44** — **Given** a flag with 120 audit rows (some with equal `at`), **When** an admin pages with `limit=50`, **Then** three pages of 50, 50 and 20 using `nextCursor`, in the same deterministic order, with no row repeated or skipped; the default limit is 50 and `limit=201` or `limit=0` answers `400 validation_failed`; a cursor that is not one this endpoint issued answers `400 invalid_cursor`.
3. **AS-45** — **Given** a change whose audit row cannot be written (failure forced on the audit write), **When** an admin saves or kills a flag, **Then** the whole change rolls back: no flag change, no audit row, no outbox row, no ruleset version bump, no push; the response is `500` problem+json with a generic `detail` (no SQL, no stack).
4. **AS-46** — **Given** the audit trail of a flag, **When** any `PUT`, `PATCH`, `POST` or `DELETE` is sent to `/api/admin/flags/:key/history` or `/api/admin/flags/:key/history/:id`, **Then** `404` or `405` and the rows are unchanged; **Given** an archived flag, **Then** its rows remain and stay readable; **Given** an unknown key, **Then** `404 flag_not_found`.
5. **AS-47** — **Given** any applied change (create, update, kill, restore, archive), **When** it commits, **Then** one outbox row of type `experimentation.flag_changed` (version 1, with `eventId`, `occurredAt`, `flagKey`, `action`, `flagVersion`, `actorId`; no definition) is committed in the same transaction; a no-op change writes none.

---

### User Story 6 — Flags do not rot (Priority: P2)

Flags are tech debt. Admins get a report of expired flags and flags nobody has evaluated for two weeks, so they can delete them.

**Why this priority**: the notes name stale-flag cleanup explicitly.

**Independent Test**: seed flags with different ages, expiry and evaluation counts and read the report.

**Acceptance Scenarios**:

1. **AS-48** — **Given** on the frozen day D: flag A with `expiresAt` in the past and evaluations; flag B created 20 days ago with no evaluations in 14 days; flag C created 3 days ago with no evaluations; flag D archived with no evaluations; flag E evaluated yesterday, **When** an admin calls `GET /api/admin/flags/stale`, **Then** `200 {days: 14, items}` containing exactly A (`reason: "expired"`, `expired: true`, its evaluation total) and B (`reason: "unused"`, `evaluations: 0`), each with `key`, `owner`, `status`, `expiresAt`, `createdAt`, `evaluations`, sorted by key; C, D and E are absent.
2. **AS-49** — **Given** `days` of `0`, `31` or `abc`, **When** the report is requested, **Then** `400 validation_failed`; `days=30` is accepted; the default is 14.
3. **AS-50** — **Given** an `enabled` flag whose `expiresAt` has passed, **When** it is evaluated, **Then** its rules and rollouts apply exactly as before (expiry never changes evaluation; it only appears in the report).

---

### User Story 7 — A route stays invisible until its flag is on (Priority: P2)

A team ships an endpoint dark. Until the flag is on for the caller, the route answers exactly like a route that does not exist. Shop allowlists and a `plan` supplied by the calling service decide who sees it (for example "auctions only for Pro shops").

**Why this priority**: it is how deploy and release are decoupled in practice (P0802).

**Independent Test**: call a gated route as callers inside and outside the targeting.

**Acceptance Scenarios**:

1. **AS-51** — **Given** a route gated by flag `auctions-v2` that is off for the caller, **When** the caller requests it, **Then** the answer is the same `404` problem+json (`type`, `title`, `status`, `detail`) as a request to an undefined route (only `instance` and `requestId` differ), and the handler does not run; **Given** the flag is on for the caller, **Then** the handler runs; **Given** the flag is unknown, archived, `disabled` or `killed`, **Then** `404`; after a kill, `404` within 1 second.
2. **AS-52** — **Given** a rule `shopId in [A, B]` → `on` and a rule `plan eq PRO` → `on` (the `plan` supplied by the calling service as part of the evaluation context), default `off`, **When** evaluated for shop A, for shop C on plan `PRO`, and for shop C on plan `STARTER`, **Then** the results are `on`, `on` and `off`; the gate for a request from shop C answers `404`.

---

### User Story 8 — Only admins change flags, and the capability is safe to operate (Priority: P2)

Admin routes require an admin. Failures are uniform problem+json. Admin writes are rate limited. The capability owns its data and exposes only its public entry point.

**Why this priority**: a flag write is a production write.

**Independent Test**: call every admin route with no credentials, a shop owner's token and an admin's token.

**Acceptance Scenarios**:

1. **AS-53** — **Given** no credentials, **When** any admin route (`GET /api/admin/flags`, `GET /api/admin/flags/:key`, `GET /api/admin/flags/stale`, `PUT /api/admin/flags/:key`, `POST …/kill`, `POST …/restore`, `POST …/archive`, `GET …/history`) is called, **Then** `401` problem+json for each.
2. **AS-54** — **Given** a signed-in shop owner, a shop member and a regular buyer, **When** each calls every admin route (existing key and unknown key alike), **Then** `403` problem+json for each, with an identical body for existing and unknown keys; nothing changes; no audit row.
3. **AS-55** — **Given** an admin, **When** they send the 31st write (`PUT`, `kill`, `restore`, `archive`) within one minute, **Then** `429` problem+json with `Retry-After`; the first 30 are processed; reads are not counted.
4. **AS-56** — **Given** 130 flags of mixed status, **When** an admin lists them with `limit=50`, **Then** `{items, nextCursor}` in ascending key order with a unique tiebreaker, three pages of 50, 50 and 30 without repeats; `status=killed` filters; archived flags are excluded unless `includeArchived=true`; `limit` above 200 or below 1 answers `400`; `GET /api/admin/flags/:key` answers the flag or `404 flag_not_found`; no response contains evaluation counters.
5. **AS-57** — **Given** the capability's tables and cache key prefixes, **When** the static gates run, **Then** the ownership registry lists every flag table under `domain:experimentation` only, `pnpm --dir packages/backend check:table-ownership` prints no line for `experimentation`, `check:boundaries` and `check:module-graph` are green, and the public entry point exports the SDK client, the route gate, the evaluation context type and the module classes but no repository, model, or query helper.
6. **AS-58** — **Given** a running system, **When** flags are evaluated, saved, killed and refreshed, **Then** the metrics `flags_evaluations_total{flag,reason}`, `flags_ruleset_version`, `flags_ruleset_age_seconds`, `flags_ruleset_rejected_total`, `flags_publish_failures_total` and `flags_refresh_failures_total` carry the exact expected values; the admin write log line carries `requestId`, `actorId`, flag key, action and flag version, and never the definition body, variant values, or any header.

### Edge Cases

- A rollout widened from 5% to 20% and narrowed back: users flip only at the thresholds; the set at 5% is always a subset of the set at 20% (AS-03).
- A user who signs in changes bucketing unit (anonymous id → user id) and may change variant; this is documented behaviour, not a defect (Assumptions).
- Two admins save at once (AS-06, AS-07), kill races a save (AS-33), repeat kills (AS-31), a replayed save (AS-04), repeated archive (AS-36).
- A snapshot that arrives twice, late or out of order (AS-23); corrupt snapshots (AS-24); lost push (AS-22); lost publication (AS-25, AS-26); cache flush (AS-28); slow cache (AS-27); both stores down at cold start (AS-20) and at run time (AS-18).
- An unknown, archived or malformed flag key (AS-08, AS-17, AS-36, AS-09); the 501st flag (AS-12); oversized bodies and oversized definitions (AS-09, AS-11).
- A non-admin trying admin routes with a flag key that does or does not exist (AS-54); context headers sent by a client (AS-39–AS-41).
- An expired flag keeps evaluating (AS-50).

## Requirements *(mandatory)*

### Functional Requirements

**Definitions and validation**

- **FR-001**: A flag has a unique, immutable `key` matching `^[a-z0-9][a-z0-9-]{1,63}$`, a `description` (≤ 500 characters, may be empty), an `owner` (required, 1–100 characters), a list of `variants`, a `defaultVariant`, an `offVariant`, an ordered list of `rules`, a `bucketBy` (`userId` or `shopId`, default `userId`), a `clientSide` boolean (default `false`), an optional `expiresAt`, a `status`, a `version`, `createdAt` and `updatedAt`. (AS-01, AS-09)
- **FR-002**: A variant has a `key` (`^[a-z0-9][a-z0-9_-]{0,31}$`, unique within the flag) and a `value` that is a boolean, string, number or JSON object whose serialised size is ≤ 4 KiB. Values of `clientSide` flags are visible to every visitor and must never hold secrets (documented in the admin API). (AS-10, AS-11)
- **FR-003**: A rule has an `id` (`^[a-z0-9-]{1,32}$`, unique within the flag), 0–10 `conditions`, and exactly one of `variant` (a fixed variant) or `rollout` (1–10 slices, each a distinct existing variant with an integer weight ≥ 0 in basis points, summing to exactly 10,000). A rule with both, or neither, is invalid. (AS-10)
- **FR-004**: A condition has an `attribute` from the closed set `userId`, `shopId`, `role`, `email_domain`, `country`, `platform`, `plan`; an `op` from `in`, `not_in`, `eq`, `neq`, `gte`, `lte`, `exists`; and `values` with the arity of FR-021. (AS-10)
- **FR-005**: `defaultVariant`, `offVariant` and every rule variant must name an existing variant; `expiresAt` must be in the future when it is set or changed. All semantic problems of one request are reported together as `422 flag_definition_invalid` with `errors: [{path, code}]`; shape problems are `400 validation_failed` (the global validation pipe, unknown properties refused); a body above 256 KiB is `413`. (AS-09, AS-10)
- **FR-006**: Limits: 20 variants, 50 rules, 10 conditions per rule, 100 values per condition, 4 KiB per variant value, 500 non-archived flags. Exceeding one is `422 flag_definition_invalid` (limit codes) or `422 flag_limit_reached` (flag count, enforced by the store so concurrent creates cannot exceed it). (AS-11, AS-12)

**Lifecycle**

- **FR-010**: A flag is in exactly one status: `enabled`, `disabled`, `killed` or `archived`. A new flag is `enabled` or `disabled` as submitted. Legal transitions: `enabled` ↔ `disabled` by save; `enabled` or `disabled` → `killed` by kill; `killed` → `disabled` by restore; `disabled` or `killed` → `archived` by archive. Every other transition is `409 invalid_transition` (or the specific codes below). Each transition is a conditional update that asserts one affected row, and its audit row is written in the same transaction. (AS-30 – AS-36)
- **FR-011**: `PUT /api/admin/flags/:key` creates (`expectedVersion: 0`, `201`, `Location`) or updates (`expectedVersion` = current version, `200`). A stale `expectedVersion` with a different definition is `409 version_conflict` with `currentVersion`; an unknown key with `expectedVersion > 0` is `404 flag_not_found`; two simultaneous saves with the same `expectedVersion` yield exactly one success. A save equal to the stored definition is a no-op `200` (FR-014). (AS-01 – AS-08)
- **FR-012**: Kill (`POST /api/admin/flags/:key/kill`, `204`) is unconditional and idempotent: it needs no `expectedVersion`, sets `killed` whatever the previous non-archived status, and a repeat or concurrent repeat changes nothing further. Kill wins every race: a killed flag is never `enabled` until restored. A save with `enabled: true` on a killed flag is `409 flag_killed`; other edits with `enabled: false` are accepted and keep the status `killed`. (AS-30 – AS-34)
- **FR-013**: Restore (`POST …/restore`, `204`) moves `killed` to `disabled` and never directly to `enabled`. Archive (`POST …/archive`, `204`) is allowed from `disabled` or `killed`, idempotent when already archived, and `409 invalid_transition` from `enabled`. An archived flag cannot be saved, killed or restored (`409 flag_archived`), its key cannot be reused, it leaves the ruleset, and its history is kept. (AS-35, AS-36)
- **FR-014**: A save, kill, restore or archive that changes nothing writes no audit row, no outbox row, does not change `version` or `updatedAt`, does not bump the ruleset version and publishes nothing. (AS-04, AS-31)
- **FR-015**: `GET /api/admin/flags` lists flags with keyset pagination (`limit` 1–200, default 50, opaque `cursor`, order `key` ascending), an optional `status` filter and `includeArchived` (default `false`); `GET /api/admin/flags/:key` returns one flag. Both return the explicit `flagSchema` response shape with no internal columns. (AS-56)

**Evaluation**

- **FR-020**: Evaluation is a pure function of a flag definition and an evaluation context: no I/O, no clock, no randomness; the same inputs give the same result in every process. Order: a `killed` flag serves its `offVariant` with reason `killed`; a `disabled` flag serves its `offVariant` with reason `off`; otherwise the first rule whose conditions all hold decides (a fixed variant, reason `rule`; or a rollout slice, reason `rollout`); with no matching rule the `defaultVariant` is served with reason `default`. The result carries `key`, `variant`, `value`, `reason`, `ruleId` (when a rule decided) and `flagVersion`. (AS-13)
- **FR-021**: Operator semantics over a context attribute: `eq` and `in` are false when the attribute is absent; `neq` and `not_in` are true when it is absent; `exists` is true only for a present, non-empty value; `gte` and `lte` are true only for a numeric attribute; an array-valued attribute satisfies `in` when any element is in `values` and satisfies `not_in` only when no element is. Arity: `eq`, `neq`, `gte`, `lte` take exactly 1 value (a number for `gte`/`lte`); `in`, `not_in` take 1–100; `exists` takes none. (AS-13)
- **FR-022**: Rollout bucket = `murmur3(flagKey + ":" + unit) mod 10000` where `unit` is the context attribute named by `bucketBy`; slices are taken by cumulative weight, so a larger weight for a variant only adds users to it, and different flags bucket independently. Without a usable unit (absent or empty), a rollout serves its first slice's variant with reason `rollout`. (AS-02, AS-03, AS-14 – AS-16)
- **FR-023**: The evaluation context is `userId`, `shopId`, `role`, `email_domain`, `country`, `platform`, `plan`; services supply it. A service that knows the shop's plan (from S18) supplies `plan`; this capability never looks it up. (AS-52)
- **FR-024**: The bucketing function `bucketOf(salt, unit)` is the single implementation of the assignment hash. S39 uses it with the experiment id as `salt`, so flags and experiments assign identically (P0811). It is exported through the public entry point and has the reference-vector test of AS-15.
- **FR-025**: An unknown or archived flag key is never an error: `evaluate` returns `reason: "unknown_flag"`, `isEnabled` returns `false`, `value(key, ctx, fallback)` returns the caller's fallback. Before a ruleset has ever been loaded, `evaluate` returns `reason: "ruleset_unavailable"` and `value` returns the fallback. (AS-17, AS-20)

**Propagation and the local SDK**

- **FR-030**: Every backend process that evaluates flags holds the full ruleset (every non-archived flag, killed and disabled included) in memory, and evaluation performs no network call. The process stays live and ready whatever the state of the flag stores (VIII.3). (AS-18, AS-20)
- **FR-031**: Each committed change assigns a new ruleset version in the same transaction. Versions strictly increase, are stored in the primary database, and survive loss of the cache. After commit, the full snapshot is published to the shared cache (with a time to live) and a push notification carrying only the version is sent; publication never delays or fails a committed write (timeout 500 ms; failures are counted and repaired by FR-033). (AS-25, AS-28)
- **FR-032**: An SDK applies a snapshot only when it validates against the snapshot schema and its version is greater than the version in use; older, equal and invalid snapshots are ignored and counted. A push triggers an immediate refresh; independent polling every 30 s with up to 5 s jitter is the fallback. Refresh reads the cache first (timeout 500 ms), then the primary database (timeout 2 s); a failed refresh keeps the current ruleset. (AS-21 – AS-24, AS-27)
- **FR-033**: A repair job, run once per schedule across replicas, republishes the snapshot whenever the cache holds none or an older version than the database. (AS-26)
- **FR-034**: At start the SDK loads from the cache, else from the primary database; if neither answers it starts not-ready and retries every 5 s until a ruleset loads. (AS-19, AS-20)
- **FR-035**: Evaluation counts are aggregated in memory per flag and flushed to a per-UTC-day counter every 30 s and on graceful shutdown; a failed flush keeps the counts for the next attempt; counters expire after 40 days; flushing never blocks or fails evaluation. (AS-29)
- **FR-036**: A change is visible to every connected process within 1 s, and to every process within 35 s even when the push is lost (SC-003). A kill is no slower than any other change.

**Client endpoint and route gate**

- **FR-040**: `GET /api/flags` is public and returns `{version, flags: {<key>: {variant, value}}}` for flags with `clientSide = true` that are in the ruleset (killed and disabled ones show their off variant). It never returns rules, rollouts, owners, descriptions or flags that are not client-side. Responses are `Cache-Control: private, no-store` with `Vary: Authorization, X-Anonymous-Id`. The variant is returned so the client can log an exposure to S39 (`exposure` events). (AS-37, AS-38)
- **FR-041**: The evaluation context for the endpoint is built only from the authenticated principal (`userId`, `role`, `email_domain`) and from the shop verified by the shop-membership check (`shopId`, S03). A client-sent shop, user id, role or email is ignored. For visitors without a session the unit is `X-Anonymous-Id` when it is 8–64 characters of `[A-Za-z0-9_-]`, else absent. (AS-39, AS-40)
- **FR-042**: `platform` is accepted only from `web`, `ios`, `android` (anything else is absent). (AS-41)
- **FR-043**: Client endpoint requests are rate limited to 120 per minute per principal, or per IP address for visitors; excess is `429` with `Retry-After`. (AS-42)
- **FR-044**: `country` is taken only from the edge-provided header when the request carries the edge's shared credential; otherwise it is absent (IV.7). (AS-41)
- **FR-045**: A route gate (`RequireFlag(key)`) answers a request with a `404` identical to an undefined route unless the flag evaluates to `true` for the caller's context (built as in FR-041); an unknown, archived, disabled or killed flag gates closed. (AS-51, AS-52)

**Audit and hygiene**

- **FR-050**: Every applied create, update, kill, restore and archive writes exactly one audit row in the same transaction as the change: `id`, `flagKey`, `action` (`create`, `update`, `kill`, `restore`, `archive`), `actorId` (required), `requestId`, `at`, `before` (null on create) and `after`. Audit rows are append-only: no route and no code path updates or deletes them, and they outlive the flag. (AS-43, AS-45, AS-46)
- **FR-051**: `GET /api/admin/flags/:key/history` pages through audit rows newest first (`at` descending, `id` descending as the tiebreaker), opaque cursor, `limit` 1–200, default 50. (AS-43, AS-44)
- **FR-052**: Each applied change also commits one outbox event `experimentation.flag_changed` (version 1) in the same transaction; it carries no definition. (AS-47)
- **FR-053**: `GET /api/admin/flags/stale?days=N` (1–30, default 14) lists non-archived flags that are expired (`expiresAt` in the past) or older than `N` days with no evaluations in the last `N` days, with the evaluation total of that window. Expiry never changes evaluation. (AS-48 – AS-50)

**Access, errors, operations**

- **FR-060**: Admin routes require an authenticated admin: no credentials `401`, any other role `403` with the same body for existing and unknown keys. Flags are platform-wide (they have no tenant), so access control is role-based. (AS-53, AS-54)
- **FR-061**: Admin writes are rate limited to 30 per minute per admin; excess is `429` with `Retry-After`. (AS-55)
- **FR-062**: Every error is RFC 9457 `application/problem+json` through the global filter with `type`, `title`, `status`, `detail`, `instance`, `requestId`; machine codes named above appear in `type`; a 5xx has a generic `detail`. Request and response bodies are defined in `packages/contracts` (`flagSchema`, `flagInputSchema`, `flagPageSchema`, `flagAuditPageSchema`, `clientFlagsSchema`, `staleFlagsSchema`, `flagRulesetSnapshotSchema`) and e2e specs parse with them. (AS-01, AS-37, AS-43, AS-45)
- **FR-063**: The capability owns its flag tables, ruleset version store and cache key prefix; nothing in another domain reads or writes them; cross-domain access is only through the exports of the Cross-capability contracts section. (AS-57)
- **FR-064**: The metrics and the log line of AS-58 exist; cardinality of the `flag` label is bounded by the 500-flag limit.

### Key Entities

- **Flag**: a key, its definition (variants, rules, default and off variant, `bucketBy`, `clientSide`, `owner`, `expiresAt`), a `status`, a `version`, timestamps.
- **Variant / Rule / Condition / Rollout slice**: parts of a definition (FR-002 – FR-004).
- **Evaluation context**: the attributes a caller supplies for one evaluation (FR-023).
- **Evaluation**: `key`, `variant`, `value`, `reason`, `ruleId?`, `flagVersion`.
- **Ruleset snapshot**: all non-archived flags plus a strictly increasing ruleset `version`; the unit that is published, pushed and held in memory.
- **Audit entry**: an append-only record of one applied change (FR-050).
- **Flag-changed event**: the outbox event of FR-052.
- **Evaluation counter**: per flag per UTC day, used only for the stale report.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A flag check costs no network call, and the evaluator sustains more than 1,000,000 evaluations per second per CPU core in an ops microbenchmark (not an e2e row).
- **SC-002**: After a kill, 100% of connected processes serve the off variant within 1 second and 100% of processes within 35 seconds even when push is lost (AS-21, AS-22, AS-30).
- **SC-003**: A change is never half-visible: an SDK applies the whole snapshot or none, and never moves to an older version (AS-23, AS-24).
- **SC-004**: With both flag stores down, the share of evaluations that fail or add latency is 0%; the process stays ready (AS-18).
- **SC-005**: A configured percentage is delivered within ±1 percentage point (at 20,000 users and up) and the same user keeps the same variant on 100% of repeated evaluations and across restarts (AS-02, AS-14).
- **SC-006**: 100% of applied changes have exactly one audit row, written atomically with the change; 0% of no-op saves write one (AS-04, AS-45).
- **SC-007**: Under any pair of simultaneous admin requests, the stored flag matches exactly one request's effect, and a killed flag is never enabled (AS-06, AS-07, AS-33).
- **SC-008**: The client endpoint exposes 0 rules and 0 non-client flags, and its p99 latency at 500 flags is under 50 ms.
- **SC-009**: An admin who is not an admin changes 0 flags (AS-53, AS-54).
- **SC-010**: The 30 admin writes a minute limit and 120 client reads a minute limit are enforced exactly (AS-42, AS-55).

## Assumptions

- Flags are platform-wide; there are no per-tenant flag namespaces. Tenant targeting is by `shopId` in rule conditions. Only role `ADMIN` manages flags.
- `shopId` in an evaluation context always comes from a verified source (S03's membership check or a service that already holds the shop id from its own trusted context), never from client input.
- Stickiness holds per bucketing unit. When a visitor signs in, the unit changes from the anonymous id to the user id and the variant may change; carrying the anonymous assignment over is out of scope (S39 handles experiment continuity).
- The edge sets the `country` header and a shared credential; the gateway strips client-supplied copies (IV.7). If the credential is missing the country is unknown.
- The ruleset is small (≤ 500 flags, ≤ 5 MiB serialised); every process holding all of it is acceptable.
- Services push through the existing realtime channel `flags` (a `SERVICE`-role topic); it only ever carries the version (nothing that must be delivered), because polling and the repair job guarantee delivery (IV.3). Browsers poll `GET /api/flags`; they are not pushed to.
- Evaluation counts are approximate (lost on a process crash between flushes); the stale report tolerates that.
- Expiry is advisory. An expired flag keeps evaluating, because silently changing behaviour at a date can cause an outage.
- The metrics backend and the log pipeline already exist (VIII.1, VIII.2).
- The Interview-Prep notes use `% 100` in one summary and `% 10000` in the worked example and SD-38; this spec uses 10,000 buckets (basis points) as the section and the code do.
- All other defaults are listed in `questions.md`.

## Cross-capability contracts

**Provides** (names exact; exported through `@app/domains/experimentation` unless stated):

- `FlagsSdkModule` (global Nest module; import once per app) and the provider `FlagsClient` — IX.7 **R1** (in-process, same deployment process):
  - `isEnabled(key: string, ctx: EvalContext): boolean` — `false` for unknown, archived or not-yet-loaded flags.
  - `value<T extends FlagValue>(key: string, ctx: EvalContext, fallback: T): T` — the caller's `fallback` for unknown, archived or not-yet-loaded flags.
  - `evaluate(key: string, ctx: EvalContext): Evaluation` where `Evaluation = {key, variant, value, reason: 'off' | 'killed' | 'rule' | 'rollout' | 'default' | 'unknown_flag' | 'ruleset_unavailable', ruleId?, flagVersion}`.
  - `ready: boolean`, `version: number` (ruleset version in use).
  - Guarantees: no I/O per call, synchronous, never throws for a bad key; sticky and widening-only rollouts; picks up changes within 1 s (push) or 35 s (fallback).
- `RequireFlag(key: string)` — a route decorator that gates a handler (`404` while the flag is off for the caller, FR-045). R1.
- Types `EvalContext = {userId?, shopId?, role?, email_domain?, country?, platform?, plan?: string}`, `FlagValue`, `Evaluation`.
- `bucketOf(salt: string, unit: string): number` in `[0, 10000)` — the assignment hash, used by S39 with the experiment id as `salt` (P0811).
- Domain event `experimentation.flag_changed`, version 1, via the outbox: `{eventId: uuid, type, version: 1, occurredAt: ISO instant, flagKey, action: 'create' | 'update' | 'kill' | 'restore' | 'archive', flagVersion: number, actorId: uuid}`; keyed by `flagKey`. Contract exported as `flagChangedEventSchema`. No consumer exists yet; it is for ops dashboards and deploy markers.
- HTTP, consumed by the BFF or the Next.js server on behalf of the browser (R2, forwarding the principal, `X-Anonymous-Id` and the edge's `country` header with its shared credential; the response is never cached by a shared cache) and by **W06**:
  - `GET /api/flags` → `clientFlagsSchema`.
  - `GET /api/admin/flags` → `flagPageSchema`; `GET /api/admin/flags/:key` → `flagSchema`; `PUT /api/admin/flags/:key` (body `flagInputSchema` with `expectedVersion`) → `201`/`200` `flagSchema`; `POST /api/admin/flags/:key/kill|restore|archive` → `204`; `GET /api/admin/flags/:key/history` → `flagAuditPageSchema`; `GET /api/admin/flags/stale` → `staleFlagsSchema`.
  - `flagSchema` = `{key, description, owner, status: 'enabled' | 'disabled' | 'killed' | 'archived', enabled: boolean (status === 'enabled'), variants, defaultVariant, offVariant, rules, bucketBy, clientSide, expiresAt: string | null, version, createdAt, updatedAt}`.
- Realtime topic `flags` (service-only) through `FlagTopicsModule` for the SSE gateway.

**Requires**:

- **S01** (`identity`): an authenticated principal `{id: uuid, role: 'ADMIN' | …, email}` on every request, and the guard decorators for "admin only" and "anonymous allowed" (used through the `identity` entry point). A failed token is `401`.
- **S03** (`tenancy`): the verified active shop id on a request (set only after a membership check), used as `shopId` for the endpoint and the route gate; absent for visitors and users without an active shop.
- **S39** (`experimentation`, same domain): that exposures are logged through its ingestion with `name: 'exposure'` and `props: {flag_key, variant, flag_version}` (all strings), and that it assigns experiments with `bucketOf`. S39's spec does not exist yet (`questions.md`, CONTRACT).
- **S18** (`billing`): nothing from this capability's side. Callers that target on `plan` obtain it from S18's entitlement export and put it in the `EvalContext`.
- **Infrastructure** (`@app/infrastructure/*`, not capabilities): the outbox append service (IX.6), the shared cache client, the rate limiter with the two profiles of FR-043 and FR-061, the topic registry, the clock, the metrics registry.
