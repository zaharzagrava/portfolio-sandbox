# Test Plan: S38 — Feature Flags and Remote Config (domain `experimentation`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (58 scenarios, AS-01 to AS-58), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. Where a cell names two parts, each proves a different part of the scenario (stated in the cell); no part is proven twice.

- API e2e files live in `packages/backend/libs/domains/experimentation/`. Each file's top-level `describe` names its feature (VII.8). They boot the real feature modules (`FlagsSdkModule`, `FlagsAdminModule`, `FlagTopicsModule` as the file needs, plus real identity for tokens and tenancy for the verified shop) with the production global pipe, problem+json filter, prefix and interceptors, call them through `supertest`, and run against the real Postgres and Redis of `docker-compose.test.yaml` with real migrations applied. The project's own repositories, cache and stores are never mocked or stubbed.
- Only system-edge dependencies are faked or spied: the access-token verifier, time (frozen; the clock is advanced explicitly for poll intervals, counters, expiry and the rate-limit window), the edge credential check for the `country` header. To force a fallback path (VII.9) a failure, hang or delay is injected on the named dependency's client: cache unreachable or slow (AS-18, AS-20, AS-25, AS-27), primary database unreachable (AS-18, AS-20), push channel dropping messages (AS-22), audit write failing (AS-45), cache flush (AS-28).
- Every e2e parses success bodies with the matching `packages/contracts` schema (`flagSchema`, `flagPageSchema`, `flagAuditPageSchema`, `clientFlagsSchema`, `staleFlagsSchema`) and error bodies with the problem schema (VII.6). Every test asserts the response and the persisted state (flag rows, audit rows, ruleset version, outbox rows, cache snapshot and counters, metric values).
- Mandatory per-endpoint cases (VII.3): `PUT /admin/flags/:key` → AS-01 (happy), AS-09, AS-10, AS-11 (validation classes), AS-53 (401), AS-54 (403 and no existence leak), AS-05, AS-06, AS-07 (state and concurrency), AS-55 (429); `POST …/kill` → AS-30, AS-31, AS-32, AS-33, AS-53, AS-54; `POST …/restore` and `…/archive` → AS-35, AS-36, AS-53, AS-54; `GET /admin/flags`, `GET /admin/flags/:key` → AS-56, AS-53, AS-54; `GET …/history` → AS-43, AS-44, AS-46, AS-53, AS-54; `GET /admin/flags/stale` → AS-48, AS-49, AS-53, AS-54; `GET /flags` → AS-37 – AS-42 (public, so no 401; AS-37 asserts it stays public; AS-39 is its cross-tenant case).
- Idempotency (V.6 does not apply to flags; replay safety is by definition equality and idempotent kill/archive): AS-04, AS-31, AS-36. Concurrency (`Promise.all`): AS-06, AS-07, AS-12, AS-31, AS-33, AS-26 (two repair runs).
- There is no async consumer in this capability (the SDK is a subscriber of a version-only notification, covered by AS-21 – AS-24 which include duplicate and invalid input); the VII.4 pair is satisfied by AS-23 (duplicate delivery, single effect) and AS-24 (invalid payload, no side effect).
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5). No unit tests for controllers, repositories, the SDK client, or glue.
- UI journey (Playwright, happy path only, owned by W06; no edge case from the API layer is repeated): `packages/web/tests/admin-flags.spec.ts` (W06's spec does not exist yet, see `questions.md`).
- Static gates (VII.1, AS-57): `tsc --noEmit` and ESLint for `packages/backend` and `packages/contracts`; `pnpm --dir packages/backend check:boundaries`, `check:module-graph`, `check:model-registry`, `check:table-ownership --strict`.
- The capacity proof of SC-001 and SC-008 is an operations artifact (`bench:flag-evaluator`, `loadtest:client-flags`), not an e2e row.

Abbreviations for the e2e files (all under `libs/domains/experimentation/`):

| Key | File | Top-level `describe` |
|---|---|---|
| ADM | `flags-admin.e2e-spec.ts` | `Flags admin API (S38)` |
| LIF | `flags-lifecycle.e2e-spec.ts` | `Flag lifecycle and kill switch (S38)` |
| SDK | `flags-sdk.e2e-spec.ts` | `Flags local-evaluation SDK (S38)` |
| CLI | `flags-client.e2e-spec.ts` | `Client flags endpoint (S38)` |
| AUD | `flags-audit.e2e-spec.ts` | `Flag audit and stale report (S38)` |
| GAT | `flags-gate.e2e-spec.ts` | `RequireFlag route gate (S38)` |

Unit specs: `EVAL` = `domain/evaluator.spec.ts` (`flag evaluator`), `VAL` = `domain/flag-validation.spec.ts` (`flag definition validation`).

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create dark flag | ADM: 201, `Location`, `flagSchema`, flag row, one `create` audit row, ruleset version +1, evaluates off | `admin-flags.spec.ts`: admin creates a flag and sees it in the list | – |
| AS-02 ramp to 5%, sticky | SDK: 4–6% of 20,000 users on, 100 repeats equal, equal after SDK restart; audit `update` row | – | – |
| AS-03 widening only adds users | – | – | EVAL: `it.each` over steps 1%…100%, subset property |
| AS-04 no-op save / replay | ADM: 200, same version and `updatedAt`, no audit, outbox or ruleset change | – | – |
| AS-05 stale `expectedVersion` | ADM: 409 `version_conflict` with `currentVersion`, nothing changed | – | – |
| AS-06 two saves, one winner | ADM: `Promise.all`, one 200 and one 409, one audit row, ruleset +1 | – | – |
| AS-07 two creates, one winner | ADM: `Promise.all`, one 201 and one 409, one row | – | – |
| AS-08 update of unknown key | ADM: 404 `flag_not_found`, nothing persisted | – | – |
| AS-09 request-shape errors | ADM: 400 per class (missing field, wrong type, extra property, bad `expectedVersion`, bad path key) and 413 | – | – |
| AS-10 semantic definition errors | ADM: 422 `flag_definition_invalid` for three representative classes (unknown variant, weights sum, both variant and rollout), nothing persisted, all errors in one response | – | VAL: full table of every semantic class with exact `{path, code}` |
| AS-11 definition limits | ADM: 422 for two representative limits (variants, value size), nothing persisted | – | VAL: full table of every limit boundary (20/21, 50/51, 10/11, 100/101, 4 KiB, 500, 100) |
| AS-12 flag-count limit under concurrency | ADM: 499 seeded, `Promise.all` of two creates → one 201 and one 422 `flag_limit_reached`, 500 rows; archived not counted | – | – |
| AS-13 precedence and operators | – | – | EVAL: table over status, rule order, AND of conditions, default, every operator × present, absent, array |
| AS-14 ~50% rollout, stable across restart | SDK: 45–55% of 2,000 users; fresh SDK loaded from the stores gives identical variants | – | – |
| AS-15 independent buckets, reference vectors | – | – | EVAL: 20,000-user collision count < 20; murmur3 vectors |
| AS-16 rollout without a unit | – | – | EVAL: anonymous and no-shop cases serve the first slice, reason `rollout` |
| AS-17 unknown or archived flag | SDK: `value`, `isEnabled`, `evaluate` on unknown and archived keys | – | – |
| AS-18 stores down at run time | SDK: both clients made unreachable, 10,000 evaluations identical, zero client calls, process ready | – | – |
| AS-19 cold start from the database | SDK: empty cache, flags in the database, `ready`, version equals the database version | – | – |
| AS-20 cold start with both stores down | SDK: not ready, fallbacks with `ruleset_unavailable`, process ready, loads within 5 s of recovery | – | – |
| AS-21 push propagation | SDK: save and kill reach the SDK within 1 s (`waitFor`) | – | – |
| AS-22 lost push, polling fallback | SDK: push dropped, fake clock to 35 s, applied | – | – |
| AS-23 duplicate, stale, reordered snapshots | SDK: v7, v6, v7, v7, v8 → stays 7 then 8, ignored count = 3 | – | – |
| AS-24 corrupt snapshots | SDK: bad JSON and schema-invalid snapshots rejected, version kept, metric +1, next valid applied | – | – |
| AS-25 publish failure does not fail the write | SDK: cache down, 200 within 1.5 s, rows committed, failure metric +1, SDKs read the database at poll | – | – |
| AS-26 repair job | SDK: missing and older snapshot repaired, two concurrent runs republish once, key has a TTL | – | – |
| AS-27 slow cache | SDK: 500 ms refresh timeout, database read, evaluation latency unaffected | – | – |
| AS-28 cache flush, version continuity | SDK: flush, save, published version = database version + 1, applied | – | – |
| AS-29 evaluation counters | SDK: frozen day counts +3 and +1, failed flush keeps counts, shutdown flushes | – | – |
| AS-30 kill | LIF: 204, `killed`, rules kept, one `kill` audit row, outbox row, off within 1 s including staff | `admin-flags.spec.ts`: admin kills a flag and sees it killed | – |
| AS-31 kill idempotent and concurrent | LIF: repeat and `Promise.all` kills, one audit row, version and ruleset unchanged | – | – |
| AS-32 kill unknown or archived | LIF: 404 `flag_not_found`, 409 `flag_archived` | – | – |
| AS-33 kill races a save | LIF: `Promise.all(kill, save enabled)`, final `killed` in every interleaving (repeated 20 times) | – | – |
| AS-34 save on a killed flag | LIF: 409 `flag_killed` for `enabled: true`; 200 and still killed for `enabled: false` | – | – |
| AS-35 restore | LIF: killed → disabled, `restore` audit row; restore from other states → 409 `invalid_transition` with `currentStatus` | – | – |
| AS-36 archive | LIF: transitions, idempotent repeat, ruleset removal, list and `includeArchived`, 409 `flag_archived` on save and re-create | – | – |
| AS-37 client endpoint exposure | CLI: public 200, `clientFlagsSchema`, exact body, no rules or non-client keys, headers; admin sees the same | – | – |
| AS-38 stickiness and `clientSide` flip | CLI: repeat calls, two devices of one user, flip removes the key within 1 s | – | – |
| AS-39 spoofed context (cross-tenant) | CLI: ignored `X-Shop-Id`, `?shopId`, `X-User-Id`, `X-User-Role`; verified member gets the shop variant | – | – |
| AS-40 invalid anonymous ids | CLI: `it.each` over short, long and illegal-character ids → 200, first-slice variant | – | – |
| AS-41 country and platform inputs | CLI: edge country honoured with the credential and ignored without; platform enum | – | – |
| AS-42 client endpoint rate limit | CLI: 121st request in the minute → 429 with `Retry-After` | – | – |
| AS-43 history order and content | AUD: `[kill, update, create]` with actors, `requestId`, before and after, `flagAuditPageSchema` | `admin-flags.spec.ts`: admin opens a flag's history | – |
| AS-44 history pagination | AUD: 120 rows with equal `at`, 50/50/20, no repeats; `limit` bounds and invalid cursor → 400 | – | – |
| AS-45 audit atomicity | AUD: forced audit failure → full rollback, no outbox row, no push, generic 500 | – | – |
| AS-46 audit append-only | AUD: write verbs on history routes → 404/405; archived flag's rows remain; unknown key 404 | – | – |
| AS-47 outbox event | AUD: one `experimentation.flag_changed` row per applied change, none for no-ops, parsed with `flagChangedEventSchema` | – | – |
| AS-48 stale report | AUD: seeded A–E on the frozen day → exactly A and B | – | – |
| AS-49 `days` bounds | AUD: `it.each` 0, 31, abc → 400; 30 accepted; default 14 | – | – |
| AS-50 expiry never changes evaluation | SDK: expired enabled flag keeps serving its rollout | – | – |
| AS-51 gated route looks absent | GAT: off → 404 identical to an undefined route, on → handler runs, unknown, archived, disabled, killed → 404, kill → 404 within 1 s | – | – |
| AS-52 shop allowlist and plan targeting | GAT: gate for shop C → 404 | – | EVAL: shop A, shop C on PRO, shop C on STARTER → `on`, `on`, `off` |
| AS-53 admin routes without credentials | ADM: `it.each` over every admin route → 401 | – | – |
| AS-54 non-admin roles | ADM: `it.each` role × route → 403, identical bodies for existing and unknown keys, no rows changed | – | – |
| AS-55 admin write rate limit | ADM: 31st write in a minute → 429 with `Retry-After`; reads not counted | – | – |
| AS-56 admin list and get | ADM: 130 flags, 50/50/30 pages, `status` filter, `includeArchived`, limit bounds, get and 404 | `admin-flags.spec.ts`: console list shows flags and statuses | – |
| AS-57 ownership and boundaries | ops: static gates (`check:table-ownership --strict` shows no `experimentation` line, `check:boundaries`, `check:module-graph`, `check:model-registry`) | – | – |
| AS-58 metrics and log line | SDK: metrics registry values after a scripted sequence; captured admin log line fields | – | – |
