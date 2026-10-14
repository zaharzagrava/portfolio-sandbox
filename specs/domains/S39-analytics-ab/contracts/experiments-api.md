# Contract: assignments, experiment admin, results

Schemas in `packages/contracts/src/experimentation/experiments.ts`: `assignmentsResponseSchema`, `experimentWriteSchema`, `experimentSchema`, `experimentPageSchema`, `experimentHistoryPageSchema`, `experimentResultsSchema`. Errors are problem+json with `code`. Policies are declared in `rate-limit-policies.ts` (`analyticsRatePolicies`).

## Assignments

`GET /api/experiments/assignments` — anonymous allowed; optional `Authorization`, `X-Anonymous-Id` (8–64 `[A-Za-z0-9_-]`, invalid ignored). Policy `experiments.assignments` (120/min, `userOrIp`, fail open).

`200 {assignments: {[key]: {variant}}, degraded: boolean}`; headers `Cache-Control: private, no-store`, `Vary: Authorization, X-Anonymous-Id`. `user` experiments only for the authenticated principal, `visitor` experiments only for a valid header id; draft and stopped absent; cache down → database; both down (500 ms) → `{assignments: {}, degraded: true}`.

## Admin (all `Firewall({roles:[ADMIN]})`; `401` without credentials, `403` for non-admin with an identical body whether or not the key exists)

| Route | Policy | Success | Errors |
|---|---|---|---|
| `PUT /api/admin/experiments/:key` | `experiments.admin.write` (30/min/admin, fail closed) | `201` + `Location` (create, `expectedVersion: 0`) or `200` (update, no-op) with `experimentSchema` | `400 validation_failed`, `404 not_found` (update of unknown key), `409 version_conflict` (+`currentVersion`), `409 experiment_immutable`, `422 experiment_definition_invalid {errors:[{path,code}]}`, `422 experiment_limit_reached` |
| `POST …/:key/start` | same | `200`, idempotent | `404`, `409 illegal_transition`, `409 layer_range_conflict` (+ blocking key) |
| `POST …/:key/stop` | same | `200`, idempotent | `404`, `409 illegal_transition` |
| `GET /api/admin/experiments?limit&cursor&status` | none | `200 {items, nextCursor}` order `createdAt DESC, key DESC` | `400` (limit outside 1–200, tampered cursor) |
| `GET …/:key` | none | `200 experimentSchema` | `404` |
| `GET …/:key/history?limit&cursor` | none | `200 {items:[{id, action, actorId, before, after, requestId, at}], nextCursor}` newest first | `400`, `404` |
| `GET …/:key/results` | `experiments.results` (20/min/admin, fail closed) | `200 experimentResultsSchema`, `Cache-Control: no-store` | `404`, `429`, `503 analytics_store_unavailable` + `Retry-After` |

`experimentWriteSchema` (strict): `{expectedVersion, description?, owner, unit?, variants:[{key, weight}], layer, layerFrom, layerTo, metric}`. `experimentSchema` adds `key`, `status`, `version`, `startedAt`, `stoppedAt`, `startedBy`, `stoppedBy`, `createdAt`, `updatedAt`.

Semantic codes (all reported together): `variants_count`, `variant_key_invalid`, `variant_key_duplicate`, `weight_invalid`, `weights_sum`, `layer_range_invalid`, `layer_invalid`, `metric_unknown`, `metric_unit_mismatch`, `owner_required`. Existing problem names `version_conflict` and `illegal_transition` are shared with S38 (raised with S39's detail).

## Results body (`experimentResultsSchema`)

```text
{ experiment, version, status, metric, unit, analysis: "fixed_horizon", windowStart, windowEnd, asOf, alpha,
  trustworthy, problems: ["srm_mismatch" | "crossover_exceeds_threshold"],
  srm: {chiSquare, pValue, mismatch},
  excluded: {unattributable, unknownVariant, crossoverUnits},
  variants: [{variant, exposures, conversions, conversionRate,
              comparison: "control" | "available" | "insufficient_sample" | "withheld_untrustworthy" | "no_data",
              vsControl?: {absoluteDifference, relativeLift|null, zScore, pValue, confidenceInterval95: [lo, hi], significant}}] }
```

`vsControl` exists only when `comparison = "available"`. Every number is finite. Thresholds (one constant each, `domain/results.ts`): SRM `p < 0.001`, crossover `> 1 %` of exposed units, minimum arm 100 units, `alpha = 0.05 / (variants − 1)`.

## Metrics (names and labels fixed by AS-54)

`analytics_events_total{outcome,reason}`, `analytics_ingest_requests_total{status}`, `analytics_produce_failures_total`, `analytics_edge_produce_failures_total` (edge, logged and counted in the worker), `analytics_rate_limited_total`, `analytics_rate_limiter_degraded_total`, `analytics_dead_letter_total{source}`, `experiment_assignments_total{outcome}`, `experiment_results_total{trustworthy}`, `experiment_srm_mismatch_total`, `analytics_store_errors_total{operation}`.

## Breaking changes (from `questions.md`)

`PUT` answers `201/200` with a body (was `204`); `expectedVersion` required; assignments body `{assignments:{key:{variant}}, degraded}` (was `{key: variant}`); results shape replaced; stopped experiments are terminal; weights are integers summing to 10,000. Known callers: none. A search of `packages/web` and of the other backend domains for `experiments/assignments` and `admin/experiments` found no caller on 2026-10-14; the task list repeats the search before the change lands.
