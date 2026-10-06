# Showcase — Implementation Conventions

Rules every section follows, so 40+ features read like one codebase.

## Where code goes

| What | Where |
|---|---|
| Domain module (service, controller, types) | `packages/backend/libs/common/src/<domain>/` (same as `product/`, `chat/`, `ledger/`) |
| Sequelize models | `libs/common/src/models/<name>.model.ts` |
| Postgres migrations | `packages/backend/migrations/<YYYYMMDDHHMMSS>-<kebab-name>.js` (sequelize-cli, wrap in a transaction, idempotent `describeTable` guards like existing ones). Every migration sets `SET LOCAL lock_timeout = '5s'` (lesson 03/03). |
| ClickHouse DDL | `packages/backend/clickhouse/NNN_<name>.sql` |
| DynamoDB table definitions | `packages/backend/dynamodb/<table>.json` (CreateTable input) + Terraform mirror |
| Elasticsearch mappings | inside the domain's indexer service (existing pattern in `elasticsearch.service.ts`) |
| New deployable process (different latency/resource profile) | `packages/backend/apps/<name>/` + `nest-cli.json` project entry + `package.json` `start:dev:<name>` / `build:<name>` scripts. Only split out when there is a real reason (see the comment in `core.module.ts`). |
| Lambda handlers | `packages/backend/apps/lambdas/src/<handler>.ts` |
| Shared API contracts (for FE phase 2) | `packages/contracts/` (zod schemas + inferred types) |
| k6 load tests | `packages/backend/scripts/load-tests/<name>.test.js` + `pnpm loadtest:<name>` script |
| Manual request examples | `packages/backend/http/<section>.http` |
| Terraform | `infra/modules/<module>/` + `infra/envs/{demo,prod}/` |
| Runbooks / SLOs | `docs/runbooks/`, `docs/slo/` |

## Code style

- Match existing code: Nest modules per domain, `ApiConfigService` for config (add keys to `api-config/types.ts`), `@app/common/...` imports, Sequelize-typescript models with `declare` fields, UUIDv7 PKs (`uuidv7()` default).
- **Branded IDs** for new domains (`type AuctionId = Brand<string, 'AuctionId'>`), **discriminated unions** for state machines, `assertNever` for exhaustiveness (lesson 01/02).
- **Validate at boundaries** with class-validator DTOs (existing convention) for HTTP, zod for Kafka/SQS/webhook/LLM payloads.
- **Money** is integer minor units (`BIGINT` cents) — existing convention. Allocation of money across parts uses largest-remainder (`libs/common/src/utils/money/`).
- **State transitions** are conditional updates (`UPDATE ... WHERE status = :from`) + a history row in the same transaction.
- **Every async consumer is idempotent** (inbox table / unique key / conditional update) and documents why.
- **Timeouts on every outbound call**; retries only with backoff + jitter and only for idempotent operations.
- Errors: domain errors map to RFC 9457 Problem Details in `AllExceptionsFilter`; never leak internals.
- Comment density: like the existing code — a short "why" doc comment on non-obvious decisions, no narration.

## Scale block (mandatory in every section file, D23)

```
## Scale
- Target: <reads RPS> / <writes RPS>, <data volume>, <latency SLO p99>
- Hot path: <request → edge/Redis/Kafka/... → where it lands>; Postgres role: <source of truth, batched/async>
- First bottleneck & fix: <...>
- Partitioning / sharding key: <...>
- Capacity model (D25 targets): <back-of-envelope: QPS per node, nodes, partitions/shards, memory, main cost driver>
- Proof: k6 scenario + thresholds (p99, error rate) + linear-scaling run (1→2→4 instances) — written, not run
```

## Definition of done (per section)

0. Scale block honoured: the hot path never does synchronous per-request work against Postgres that could be cached, queued, batched or moved to a store built for the access pattern.
1. Code + migrations + module wired into the right app.
2. `pnpm --filter api exec tsc --noEmit -p tsconfig.json` passes (D2: typecheck allowed).
3. e2e spec(s) for the section's **critical flows** in `*.e2e-spec.ts` next to the module, against docker-compose test DBs (D5) — written + typechecked, **not run**.
4. Unit tests only for logic shared across several places (real local DBs where possible) — written + typechecked, not run.
4a. **Test plan table** in the section doc (D27 test pyramid): one row per acceptance scenario →
   `API e2e` (the deep layer: every edge case, auth/tenant, limits, idempotency, concurrency) /
   `UI journey` (FE phase, Playwright, **happy path only**, once per client that has the flow) /
   `Unit` (complex isolated logic). An edge case appears in exactly one row as API e2e - never re-tested in UI.

   ```markdown
   ## Test plan
   | Scenario | API e2e | UI journey (web / mobile) | Unit |
   |---|---|---|---|
   | Buyer completes checkout | `checkout.e2e-spec.ts` › "reserves stock…" | web: checkout happy path · mobile: same | — |
   | Reused Idempotency-Key with a different body → 422 | `public-api.e2e-spec.ts` | — | — |
   ```
5. k6 script for contention-heavy flows — **not run**.
6. `.http` examples.
7. Contracts added to `packages/contracts` for every new endpoint.
8. Section file updated: steps ticked, status, deviations logged in `DOUBTS.md`.
9. `docs/showcase/README.md` progress table updated.

## Never

- Start docker, databases, Nest/Next servers, k6, terraform plan/apply (D2, D16).
- Touch `packages/hft-platform` (Rust) or `packages/payments` (Go) (D1).
- Add a fancy algorithm a feature doesn't need (D6).
