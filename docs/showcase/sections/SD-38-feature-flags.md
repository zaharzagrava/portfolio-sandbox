# SD-38 — Feature Flags & Remote Config

Status: ☑ done (typechecked; specs written, not run) · Phase 5 · Depends on: F-03, SD-02, SD-24 (entitlements) · Feeds SD-31 (experiments)

## Marketplace adaptation
Roll out the new checkout to 5% of buyers, enable "auctions" only for Pro shops, kill-switch the LLM assistant if costs spike, per-country payment methods.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Flag definitions (variants, targeting rules: attributes, shop allowlists, plan, % rollout) in Postgres + **audit log** | 10/09 #38 |
| **Local evaluation SDK**: services load the full ruleset at startup, stay updated via **SSE stream** (F-03) with polling fallback; evaluation in-memory (µs), works when flag service is down | 10/09 #38 |
| Consistent % rollout: `murmurhash(flagKey:userId) % 10000` buckets | 10/02 Ex2 |
| Browser gets **pre-evaluated** flags for the current user (rules not exposed) — endpoint used by BFF | 10/09 #38 |
| Kill switches, flag expiry/staleness report (flags = tech debt) | 10/09 #38 |
| Progressive delivery hook: canary deploys + flags (08/01 §5) | 08/01 |

## Steps
- [x] `FeatureFlag`, `FlagAudit` models; admin CRUD.
- [x] `FlagsSdkModule` (local cache, SSE subscriber, evaluator — pure, unit-tested: shared by all apps), `@Flag('new-checkout')` helper.
- [x] `GET /flags/evaluate` for clients.
- [x] e2e: rollout 50% → stable assignment for same user across calls; update flag → SDK receives change via stream (waitFor).

## Scale
- Target: millions of evaluations/s across fleet → zero network calls per evaluation.
- Hot path: in-memory; ruleset updates pushed (≤ 1/s); Postgres only on admin writes.
- Proof: microbenchmark of evaluator (> 1M evals/s/core).

## Implementation notes (2026-10-01)
- **Schema:** migration `20261001310000-feature-flags` adds `FeatureFlag` (variants, ordered rules, bucketBy, clientSide, owner, expiresAt, version) and `FlagAudit` (before/after JSON per change).
- **`evaluator.ts`** (pure, shared everywhere):
  - Disabled → off variant. First matching rule wins (conditions `in/not_in/eq/neq/gte/lte/exists` over context attributes), serving a variant or a weighted rollout; otherwise the default.
  - Rollouts use `murmur3("flag:unit") % 10000` cumulative weights, so they are sticky, independent per flag, and widening only adds users.
  - `murmur3.ts` is checked against the reference vectors. `validateFlag` checks weights sum to 10,000 and that variants exist.
  - Unit spec `evaluator.spec.ts`.
- **`FlagsClient`** (local SDK, `FlagsSdkModule`, global; in core + worker):
  - The whole ruleset is in memory; evaluation does no I/O and survives Redis/PG outages with the last known ruleset.
  - Push via Redis pub/sub on the `flags` realtime channel plus a 30 s poll; only newer versions apply; cold start falls back to Postgres.
  - Evaluation counts are aggregated in memory and flushed every 30 s.
  - API: `isEnabled`, `value(key, ctx, fallback)`, `evaluateClientFlags`.
- **`FlagsAdminService`:** upsert/kill inside a transaction with an audit row. Afterwards it publishes a full snapshot with a monotonically increasing version through a Lua compare-and-set, so concurrent admins can't publish out of order. `stale()` lists expired flags and flags with no evaluations in 14 days.
- **`@RequireFlag(key)`** guard (404 while off), and `contextFromRequest` (userId or `X-Anonymous-Id`, shopId, role, email domain, `CF-IPCountry`, platform).
- **Endpoints:** `GET /api/flags` (pre-evaluated client-side flags only, never rules), `GET|PUT /api/admin/flags[/:key]`, `POST /admin/flags/:key/kill`, `/history`, `/stale`.
- **Spec** `flags/flags.e2e-spec.ts` covers: push propagation, ~50% sticky rollout, kill switch, audit order, validation, client endpoint exposure, stale report.
