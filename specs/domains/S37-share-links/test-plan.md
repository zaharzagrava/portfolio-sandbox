# Test Plan: S37 — Share and Affiliate Short Links (domain `marketing`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (66 scenarios, AS-01 to AS-66), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. Where a cell names two parts, each proves a different part of the scenario (stated in the cell); no part is proven twice.

- API e2e files live in `packages/backend/libs/domains/marketing/`. Each file's top-level `describe` names its feature (VII.8). They boot the real feature modules (`ShareLinksModule`, `ShareLinksWorkerModule`, `ShareLinksProjectorModule` as the file needs, plus real identity for tokens) with the production global pipe, problem+json filter, prefix and interceptors, call them through `supertest`, and run against the real engines of `docker-compose.test.yaml` (Redis, DynamoDB Local, Kafka stand-in, ClickHouse) with the table definitions and ClickHouse DDL applied. The project's own repositories, caches and stores are never mocked.
- Only system-edge dependencies are faked or spied: the access-token verifier, time (frozen; the clock is advanced explicitly for expiry, cache lifetimes and the idempotency lifetime), the reputation check port (AS-14), the edge origin and event sink (AS-41, AS-42). To force a fallback path (VII.9) a failure, hang or delay is injected on the named dependency's client: counter and filter (AS-08, AS-33), link store (AS-34, AS-47), event publish (AS-36), analytics store (AS-61), limiter store (AS-13).
- Every e2e parses success bodies with the matching `packages/contracts` schema (`shortLinkSchema`, `shortLinkPageSchema`, `linkStatsSchema`) and error bodies with the problem schema (VII.6). Events are parsed with `linkClickedEventSchema`. Every test asserts the response and the persisted state (link rows, cache entries, filter entries, counter value, published messages, dead-lettered messages, analytics rows).
- Mandatory per-endpoint cases (VII.3): `POST /links` → AS-01 (happy), AS-02, AS-03, AS-04, AS-14 (validation classes), AS-15 (401), AS-09, AS-10 (idempotency), AS-13 (429), AS-12, AS-21 (concurrency); `GET /links` → AS-48, AS-49, AS-15; `PATCH` and `disable` → AS-50 – AS-54 (transitions), AS-54 (concurrency), AS-56 (IDOR), AS-15; `GET /links/:code/stats` → AS-57 – AS-59, AS-56, AS-15; `GET /l/:code` → AS-24 – AS-37 (public, so no 401 or IDOR case; AS-15 asserts it stays public).
- VII.4 pair for the click consumer: duplicate delivery AS-43, invalid payload AS-44.
- Concurrency (`Promise.all`): AS-05 (1,000 creates), AS-06 (block exhaustion), AS-10, AS-12, AS-21, AS-32, AS-33 (two rebuilds), AS-54.
- "Interrupted" in AS-33 is a rebuild stopped without its shutdown hooks before it sets the marker.
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5). The code scheme also gets `fast-check` properties (bijection, range, non-adjacency; fixed seed). No unit tests for controllers, repositories, the lease, or glue code.
- UI journey (Playwright, happy path only, owned by W02; no edge case from the API layer is repeated): `packages/web/tests/share-link.spec.ts`. W02's spec does not exist yet (`questions.md`, CONTRACT).
- Edge worker spec (vitest, Workers pool; fake origin, fake event sink, fake cache clock): `packages/edge-be/test/short-link.spec.ts`, top-level `describe('Edge short-link redirect')`.
- Static gates (VII.1, AS-64): `tsc --noEmit` and ESLint for `packages/backend`, `packages/contracts`, `packages/edge-be`; `pnpm --dir packages/backend check:boundaries`, `check:module-graph`, `check:model-registry`, `check:table-ownership --strict`.
- The capacity proof of SC-001, SC-002 and SC-006 is an operations artifact (`loadtest:share-links`: Zipf redirects at the edge locally and at the origin, 400 creates per second), not an e2e row.

Abbreviations for the e2e files (all under `libs/domains/marketing/`):

| Key | File | Top-level `describe` |
|---|---|---|
| C | `share-links-create.e2e-spec.ts` | `Share links: creation, codes and aliases` |
| R | `share-links-redirect.e2e-spec.ts` | `Share links: redirect, caching and degradation` |
| K | `share-links-clicks.e2e-spec.ts` | `Share links: click events and attribution` |
| M | `share-links-manage.e2e-spec.ts` | `Share links: management and statistics` |
| P | `share-links-platform.e2e-spec.ts` | `Share links: operations and boundaries` |
| E | `packages/edge-be/test/short-link.spec.ts` | `Edge short-link redirect` |
| W | `packages/web/tests/share-link.spec.ts` | `Share a product link` |

Unit files (all under `libs/domains/marketing/domain/`): U1 `codes.spec.ts`, U2 `destination-policy.spec.ts`, U3 `alias-rules.spec.ts`, U4 `click-meta.spec.ts`, U5 `link-state.spec.ts`.

## Traceability

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create, happy path | C: `201`, `Location`, body parses `shortLinkSchema`, no owner field, one stored row for `U1`, metric `kind=generated` | — | — |
| AS-02 validation classes | C: each class → `400 validation_failed` naming the field; nothing stored (including missing and out-of-range `Idempotency-Key`) | — | — |
| AS-03 destination policy | C: three representative refusals (`http`, `evil.example`, `@`-trick) → `422 destination_not_allowed`, nothing stored; one accepted upper-case host stored lower-case | — | U2: table of all 13 refused variants and 2 accepted ones (IDNA, port, trailing dot, user-info, backslash, subdomain, look-alikes) |
| AS-04 reference stripped | C: stored destination equals the stripped URL | — | U2: parameter order, encoding and fragment preserved |
| AS-05 code properties | C: 1,000 concurrent creates through 3 instances → 1,000 distinct codes | — | U1: 7 chars, alphabet, 10,000 distinct, reversible, non-adjacent, key-dependent, range edges, out-of-range refused; `fast-check` properties |
| AS-06 ID leases | C: 2,500 numbers → 3 counter calls; stopped instance's block never reissued; 5 concurrent demands → 1 counter call | — | — |
| AS-07 generated code collides | C: planted alias equal to the next code → `201` with another code, original intact, collision metric; 5 collisions → `503 code_generation_failed`, no write | — | — |
| AS-08 dependency failure on create | C: counter, filter, store each forced down → `503 service_unavailable`, no link stored; retry with the same key → `201` | — | — |
| AS-09 idempotent replay | C: replay → same body and `Idempotency-Replayed`, one row; other user's same key → second link; key after 24 h → new link | — | — |
| AS-10 in flight and misuse | C: `Promise.all` of two → one `201`, one `409`; different body → `422 idempotency_key_reuse` | — | — |
| AS-11 expiry | C: `expiresAt` equals `T + 30 d`, `3650` accepted, omitted → `null` | — | — |
| AS-12 per-owner limit | C: at the limit → `422 link_limit_reached`; 999 + two racing → one `201`, one `422`; disable frees a place; other user unaffected (limit set to 5 in the test config) | — | — |
| AS-13 rate limit | C: 21st create → `429` with `Retry-After`; discussion and upload budgets independent; limiter store down → create `503`, redirect unaffected | — | — |
| AS-14 reputation hook | C: fake port block → `422 destination_blocked`; timeout → `503 destination_check_unavailable`; allow → `201` | — | — |
| AS-15 authentication | C: all five authenticated routes → `401` without credentials (one `it.each`); the public redirect is served without credentials (one assertion in the same file) | — | — |
| AS-16 error shape | C: one 4xx and one forced 5xx parse the problem schema, have `requestId`, generic `5xx` detail with no stack, SQL or store text | — | — |
| AS-17 alias happy path | C: `201`, `kind: custom`; follow-up redirect `302` | — | — |
| AS-18 alias format | C: one valid and one invalid alias through the API → `201` / `400` | — | U3: table of valid and invalid aliases (length, case, dashes, characters) |
| AS-19 reserved aliases | C: `admin`, `login`, `status` → `422 alias_reserved`, nothing stored | — | U3: reserved list matching |
| AS-20 alias taken | C: `409 alias_taken`, original unchanged, same-owner reclaim also `409` | — | — |
| AS-21 concurrent claims | C: ten `Promise.all` claims → one `201`, nine `409`, one row, redirect goes to the winner | — | — |
| AS-22 codes never reused | C: expired and disabled aliases → `409`; advancing the clock past 13 months and purging → claim succeeds | — | — |
| AS-23 just-claimed alias reachable | R: `404` first, claim, immediate `302` | — | — |
| AS-24 redirect, happy path | R: `302`, `Location` with `ref`, exact `Cache-Control`, no `Set-Cookie`, empty body, one event published after the response | W: asserted through the journey (AS-66) | — |
| AS-25 reference placement | R: fragment last, parameters unchanged | — | U2: URL assembly table (with and without query, fragment, encoded values) |
| AS-26 unknown code | R: `404`, `no-store`, no event, no store read (read count asserted), filter-reject metric | — | — |
| AS-27 malformed codes | R: each malformed code → identical `404`, no store read, no event | — | — |
| AS-28 expired | R: `T+9 s` → `302`; `T+10 s` and later → `410`, `s-maxage=60`, no event | — | U5: `now >= expiresAt` boundary table |
| AS-29 disabled | R: `410`, body identical to the expired body, no event | — | — |
| AS-30 HEAD and other methods | R: `HEAD` same status and headers, no event; `POST`, `PUT`, `PATCH`, `DELETE` → `405` | — | — |
| AS-31 remembered misses | R: filter bypassed; 100 requests → one store read; after 60 s one more | — | — |
| AS-32 hot link, one load | R: 500 concurrent requests on a cold cache → one store read, identical `Location` | — | — |
| AS-33 existence filter lost | R: bypass serves `302` and counts it; rebuild restores the marker and filter rejection; two concurrent rebuilds → one runs; interrupted rebuild leaves the filter bypassed | — | — |
| AS-34 store outage | R: warm cache serves stale `302`; cold cache + timeout → `503` with `Retry-After`, no remembered miss; recovery → `302` | — | — |
| AS-35 destination re-checked | R: stored link on a now-disallowed host → `410`, no event, rejection metric | — | — |
| AS-36 click pipeline degraded | R: publish refused → `302`, failure metric once, one structured warning without visitor data; publish hangs → response time unchanged | — | — |
| AS-37 graceful shutdown | R: stop signal with in-flight publishes → they finish within 5 s, then pools close; new requests refused | — | — |
| AS-38 click event | K: event envelope, key, `eventId = clickId`, payload fields, parses `linkClickedEventSchema`, no visitor data | — | — |
| AS-39 country and referrer clean-up | — | — | U4: tables for country and referrer inputs |
| AS-40 edge flag needs credential | K: valid credential → `302` and no event; missing or wrong credential → flag ignored, one event `viaEdge: false` | — | — |
| AS-41 edge worker | E (worker boundary, fake origin and sink): origin `302` → one event; cache hit → second event with a new `clickId`, origin not called; `404`/`410`/`5xx` → no event, no caching; sink failure → still `302` | — | — |
| AS-42 edge staleness bounded | E (fake clock): before `t0+10 s` the old `302`; after it the origin is called and the new state returned | — | — |
| AS-43 duplicate delivery | K: same event twice and after a restart → one counted click in statistics, checked before any merge | — | — |
| AS-44 invalid payloads | K: each invalid event beside a valid one → dead-lettered with reason, no row, valid counted | — | — |
| AS-45 late and out-of-order | K: shuffled delivery gives the same statistics; late event in its own minute | — | — |
| AS-46 attribution lookup | K: active, expired, disabled, unknown, malformed, empty, 101 codes; one batched read | — | — |
| AS-47 attribution lookup degraded | K: store forced down → `AttributionUnavailableError`, never an empty result | — | — |
| AS-48 list, cursor pages | M: pages, order, isolation between users, insertion between pages | — | — |
| AS-49 list limits | M: default, bounds, tampered or foreign cursor, empty list | — | — |
| AS-50 change destination | M: `200`, fields unchanged except destination and `updatedAt`, next redirect new `Location` | — | — |
| AS-51 change validation | M: empty body, immutable or unknown fields → `400`; policy or reputation failure → `422`; nothing changes | — | — |
| AS-52 disable | M: `200`, `DISABLED`, `disabledAt`, redirect `410`, still listed, statistics readable, limit count drops | — | — |
| AS-53 illegal transitions | M: disable or change on a disabled or expired link → `409 link_not_active`, nothing changes | — | U5: transition table (state × action) |
| AS-54 concurrent edit and disable | M: `Promise.all` of change + disable, two disables, two changes → outcomes as specified, final state `DISABLED` | — | — |
| AS-55 cache never outlives a change | M: warm cache, change → next request new `Location`; disable → `410` | — | — |
| AS-56 other users, IDOR | M: `PATCH`, disable, statistics by `U2` → `404` identical to unknown; malformed path code → same `404`; nothing changed | — | — |
| AS-57 statistics, happy path | M: known clicks → body parses `linkStatsSchema`, numeric counts, ordered series, top countries | — | — |
| AS-58 ranges and buckets | M: three ranges, default, bucket sizes, inclusive `from`, exclusive after `to`; invalid ranges → `400` | — | — |
| AS-59 no clicks, retained links | M: zeros and empty arrays; expired and disabled links still readable | — | — |
| AS-60 freshness | M: click published, consumer run, immediately visible in statistics; lag gauge present | — | — |
| AS-61 statistics store down | M: `503` on statistics only; create, list, change, disable, redirect still work | — | — |
| AS-62 configuration | P: each bad configuration fails startup naming the key; valid starts; no fallback to another secret | — | — |
| AS-63 metrics and logs | P: scrape matches the actions performed; log and label scan finds no destination, referrer, query, secret or visitor value | — | — |
| AS-64 boundaries | P: the static checks run and are green; barrel export list equals the Provides list | — | — |
| AS-65 clock | — | — | U5: injected-clock table over expiry and transition logic; a lint rule forbids `Date` use in `domain/` |
| AS-66 UI journey | — | W: signed-in buyer shares a product, copies the short URL; anonymous context opens it, lands on the product with `?ref=<code>`; the owner's statistics show the click | — |
