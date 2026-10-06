# Test Plan: S39 — Analytics Ingestion and A/B Testing (domain `experimentation`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (57 scenarios, AS-01 to AS-57), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. Where a cell names two parts, each proves a different part of the scenario (stated in the cell); no part is proven twice.

- API e2e files live in `packages/backend/libs/domains/experimentation/`. Each file's top-level `describe` names its feature (VII.8). They boot the real feature modules (`AnalyticsModule` with its ingest, assignment, admin and results controllers, real `identity` for tokens and roles, the purchase projector for the store file) with the production global pipe, problem+json filter, prefix and interceptors, call them through `supertest`, and run against real Postgres, real ClickHouse (with the stream engine table and a real topic on the compose test broker) and real Redis with migrations applied. The existing spec bypasses the topic and the HTTP layer; the new files must not.
- Only system-edge dependencies are faked or spied: access-token verification, the edge credential check, time (frozen; advanced explicitly for the 7-day and 10-minute boundaries, the rate-limit window and cache expiry), and the broker connection when a failure is injected. To force a fallback path (VII.9) a failure, hang or delay is injected on the named dependency's client: stream unreachable or slow (AS-08), limiter store down (AS-09), cache down and database slow (AS-23), analytical store down or slow (AS-51).
- Every e2e parses success bodies with the matching `packages/contracts` schema and error bodies with the problem schema (VII.6). Every test asserts the response and the persisted state: messages on the topic, rows in the store and error table, experiment and history rows, cache keys, metric values.
- Mandatory per-endpoint cases (VII.3): `POST /api/events` → AS-01 (happy), AS-03/04 (validation classes), AS-09 (429), AS-07/08/12 (replay and idempotency, V.6 does not apply because there is no created resource; replay safety is by `event_id`), 401 does not apply (anonymous route, AS-02 covers the stale token); `GET /api/experiments/assignments` → AS-22, AS-20 (other-user access), AS-22 (429); `PUT/start/stop` → AS-30, AS-32 (validation), AS-40 (401, 403, no existence leak), AS-31/33/34/35/36 (state and concurrency, `Promise.all`), AS-41 (429); `GET` list/history → AS-38, AS-39, AS-40; `GET …/results` → AS-42, AS-50 (404, 401, 403), AS-53 (429), AS-51 (503).
- Consumers (VII.4): the purchase projector is delivered the same message twice and an invalid payload (AS-15); the store's stream consumer is given a duplicate and a malformed message (AS-12, AS-14).
- Concurrency (`Promise.all`): AS-31, AS-33, AS-36.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5): clock and validation arithmetic, the assignment function, definition validation, the statistics. No unit tests for controllers, repositories, the cache, or glue. Property-based tests (`fast-check`) are used for the assignment function (monotone: widening a range only adds units) and the statistics (finite output for any counts).
- UI journey (Playwright, happy path only, owned by W02; no API edge case repeated): `packages/web/tests/storefront-discovery.spec.ts` (W02's spec does not exist yet, see `questions.md`). No web capability covers experiments administration, so there is no other UI row.
- Static gates (VII.1, AS-56): `tsc --noEmit` and ESLint for `packages/backend`, `packages/contracts`, `packages/edge-be`; `pnpm --dir packages/backend check:boundaries`, `check:module-graph`, `check:model-registry`, `check:table-ownership --strict`.
- Capacity proofs (SC-001, SC-004, SC-006) are operations artifacts (`loadtest:analytics-ingest`, `bench:assignment`, `bench:results`), not e2e rows.

Abbreviations for the files (API e2e under `libs/domains/experimentation/`):

| Key | File | Top-level `describe` |
|---|---|---|
| ING | `analytics-ingest.e2e-spec.ts` | `Analytics ingest API (S39)` |
| STO | `analytics-store.e2e-spec.ts` | `Analytics store, dedupe and purchase projector (S39)` |
| ASG | `experiments-assignment.e2e-spec.ts` | `Experiment assignment API (S39)` |
| ADM | `experiments-admin.e2e-spec.ts` | `Experiments admin API (S39)` |
| RES | `experiments-results.e2e-spec.ts` | `Experiment results API (S39)` |
| OPS | `analytics-ops.e2e-spec.ts` | `Analytics operations: metrics, logs, ownership (S39)` |

| Key | Unit file (under `domain/`) | Top-level `describe` |
|---|---|---|
| EVT | `event-schema.spec.ts` | `Client event schema and clock rules` |
| ASU | `experiments.spec.ts` | `Experiment assignment` |
| DEF | `experiment-definition.spec.ts` | `Experiment definition validation` |
| STA | `stats.spec.ts` (exists, extended) | `experiment statistics` |

Other: `EDGE` = `packages/edge-be/test/collect.spec.ts` (`Edge collector (S39)`, runs the shared vectors from `packages/contracts`), `UI` = `packages/web/tests/storefront-discovery.spec.ts`.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 happy ingest, stored shape | ING: three events → `202`, three messages, key, format, enrichment | — | — |
| AS-02 identity from token only, `forbidden_field`, stale token | ING: signed-in, stale token, forged body fields | — | — |
| AS-03 per-event rejection classes | ING: `it.each` one invalid event per class beside a valid one; exact `{index, code}` and stream content | — | EVT: the same classes against the pure schema (character-level boundaries: ids of 7/8/64/65 characters, 30/31 props, key and value lengths) |
| AS-04 envelope errors, size, content type | ING: `400`, `413`, `415`; nothing produced | — | — |
| AS-05 clock boundaries | ING: a clamped event reaches the topic with `ts = received_at` (wiring only) | — | EVT: `it.each` ±1 ms around `T − 7 d` and `T + 10 min`, two-day-old event keeps `ts` (arithmetic) |
| AS-06 `text/plain` beacon body | ING: same body as AS-01 as `text/plain` | — | — |
| AS-07 duplicate id inside a batch | ING: one message, `duplicate_in_batch` | — | — |
| AS-08 stream failure → 503, retry | ING: injected broker failure and 2 s hang; `Retry-After`, metric, then retry succeeds; STO covers the single stored copy | — | — |
| AS-09 ingest rate limit and fail-open | ING: 121st request `429`, other caller fine; limiter store down → accepted, metric | — | — |
| AS-10 edge and fallback parity | ING: the shared vectors against the fallback | — | EDGE: the same vectors against `/collect`; `202` before ack, 3 retries with backoff, final-failure metric, rate limit |
| AS-11 country and platform trust | ING: with and without the edge credential, `toaster`, `ios`, `server` attempt | — | — |
| AS-12 dedupe across names, times and parts | STO: the same `event_id` three ways, before and after a forced merge; first copy read; a later conflicting copy ignored | — | — |
| AS-13 out-of-order by event time | STO: purchase first/exposure second and the reverse event-time case, read through results | — | — |
| AS-14 malformed stream message | STO: a bad message between good ones through the real topic; error table row; stream continues; metric | — | — |
| AS-15 purchase projector | STO: envelope → one `purchase` row; delivered twice → one; invalid payload → none, dead-lettered, metric | — | — |
| AS-16 store definition | STO: inspect the table definitions (partition, TTLs, consumer group) | — | — |
| AS-17 determinism and reference vectors | — | — | ASU: reference table (unit → layer bucket, variant bucket, variant); repeated calls; `fast-check` stability |
| AS-18 distribution and boundary buckets | — | — | ASU: 100,000 units × three weight sets through `srmCheck`; buckets 0 and 9,999 |
| AS-19 independence and layer exclusion | — | — | ASU: chi-square independence of two layers; disjoint ranges share no unit; buckets 4,999 / 5,000; `fast-check`: widening a range only adds units |
| AS-20 unit selection and other-user access | ASG: signed in + header, header only, none, `short`; a user token plus another user's anonymous id gets only its own | — | — |
| AS-21 draft and stopped not assigned | ASG: both statuses absent | — | — |
| AS-22 response contract, headers, 429 | ASG: schema, `Cache-Control`, `Vary`, 121st request | — | — |
| AS-23 degraded assignment | ASG: cache down → database; both down (500 ms timeout) → `degraded: true`; metric | — | — |
| AS-24 stop propagation | ASG: two app instances over one cache and database, clock advanced to 15 s | — | — |
| AS-25 exposure counts toward results | RES: one exposure then results (counts the unit under its variant) | — | — |
| AS-26 exposure shape classes | ING: valid `{experiment}` and `{flag_key}` shapes, each invalid class `invalid_exposure`; RES: a flag exposure never appears in results | — | EVT: the shape rules as a table |
| AS-27 one unit, many exposures | RES: ten exposures → one unit at the first time | — | — |
| AS-28 crossover | RES: excluded, counted, over 1% → untrustworthy | — | — |
| AS-29 unknown variant, out-of-window, unknown key | RES: excluded counts; unknown experiment key accepted at ingest and ignored | — | — |
| AS-30 create draft | ADM: `201`, `Location`, schema, history row | — | — |
| AS-31 optimistic concurrency, no-op | ADM: update, stale, equal, and two parallel saves (`Promise.all`) | — | — |
| AS-32 definition validation | ADM: `400` shape classes; `422` with all `{path, code}` at once | — | DEF: `it.each` every semantic code incl. weight sum and range arithmetic |
| AS-33 start, idempotent, parallel | ADM: start, repeat, two parallel starts; one history row | — | — |
| AS-34 stop, illegal transitions | ADM: stop, repeat, start-after-stop `409`, stop-a-draft `409` | — | — |
| AS-35 immutability | ADM: each immutable field `409 experiment_immutable`; description/owner change `200` | — | — |
| AS-36 layer exclusion and concurrent starts | ADM: overlap `409`, disjoint ok, freed after stop, parallel starts → one winner; database constraint holds | — | — |
| AS-37 experiment limit | ADM: 201st key `422`; update of an existing key ok | — | — |
| AS-38 list pagination | ADM: 120 experiments in pages of 50, order, filter, bad `limit`/cursor, get one, `404` | — | — |
| AS-39 history | ADM: rows per change, none for no-op, newest first, paging, actor not null | — | — |
| AS-40 authentication and authorization | ADM: `401`, `403` buyer and shop owner on every admin endpoint; identical body for known and unknown keys | — | — |
| AS-41 admin write rate limit | ADM: 31st write `429` | — | — |
| AS-42 results happy path and numbers | RES: seeded 10,000/10,000 users, schema, header, every field | — | STA: textbook values for z, p, interval, lift (extends existing cases) |
| AS-43 conversion rules | RES: before exposure, after stop, two purchases | — | — |
| AS-44 duplicates in results | RES: duplicated unmerged parts give the de-duplicated numbers | — | — |
| AS-45 SRM verdicts | RES: 6,000/4,000 flagged, comparisons withheld | — | STA: 5,030/4,970 not flagged; 3-way exact split → `chiSquare` 0, `pValue` 1; `p < 0.001` threshold edge |
| AS-46 insufficient sample | RES: arm of 99 units → `insufficient_sample` | — | — |
| AS-47 Bonferroni | RES: three variants carry `alpha: 0.025` | — | STA: `significant` decisions for p between 0.025 and 0.05 |
| AS-48 degenerate counts | — | — | STA: zero control conversions, zero both, `fast-check` finite for any counts |
| AS-49 unit semantics in results | RES: user vs visitor experiment, `excluded.unattributable` | — | — |
| AS-50 draft/no data, 404, 401, 403 | RES: each | — | — |
| AS-51 store failure → 503 | RES: store down and 10 s hang; no partial numbers; metric | — | — |
| AS-52 late event after stop | RES: event time inside the window included, after `stoppedAt` excluded | — | — |
| AS-53 results rate limit | RES: 21st read `429` | — | — |
| AS-54 metrics | OPS: drive AS-01 – AS-11 and assert every metric and label | — | — |
| AS-55 logs | OPS: capture log output across ingest, assignment and admin requests; assert JSON, `requestId`, no props, user ids, tokens | — | — |
| AS-56 ownership and boundaries | OPS: static gates `check:table-ownership --strict`, `check:boundaries`; registry assertion for the new tables | — | — |
| AS-57 exposure once per render | — | UI: product page renders variant, exactly one `exposure` request even after re-render | — |
