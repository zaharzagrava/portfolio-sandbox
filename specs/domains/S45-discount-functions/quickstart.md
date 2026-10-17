# Quickstart: validating S45 — Seller discount functions

A run guide; contracts are in [contracts/](contracts/), tables in [data-model.md](data-model.md). Backend commands run from `packages/backend`.

## Prerequisites

Test stack up (`docker-compose.test.yaml`: Postgres, Redis, outbox/queue stand-ins, ElasticMQ with the `shop-functions.judge-version` queue defined) with migrations applied, including `<ts>-shop-functions-s45.js`. Billing is the test double that grants `shopFunctions` (research D-13).

## Narrow checks while building

```bash
scripts/sdd/test-spec.sh libs/domains/shop-functions/domain          # unit: version-state, discount-amount (fast-check), breaker
scripts/sdd/test-spec.sh libs/domains/shop-functions/infra/sandbox   # AS-14 over real isolates
scripts/sdd/test-spec.sh shop-functions-management                   # AS-01..AS-09
scripts/sdd/test-spec.sh shop-functions-judge                        # AS-10..AS-13, AS-15..AS-20, AS-22
scripts/sdd/test-spec.sh shop-functions-checkout                     # AS-24..AS-34
scripts/sdd/test-spec.sh shop-functions-ops                          # AS-35..AS-37, AS-39
```

Use `-t "AS-29"` for one scenario. The whole capability suite (four e2e files + four unit specs) runs once at the end.

## Static gates (AS-23, AS-38)

```bash
pnpm --dir packages/backend check:table-ownership --strict    # zero rows for shop-functions
pnpm --dir packages/backend check:boundaries                  # no import of @app/domains/orders from this domain
pnpm --dir packages/backend check:function-runner             # runner profile: no network, read-only, non-root, seccomp, no credentials, limits, local socket only
pnpm --dir packages/backend exec tsc --noEmit
python3 scripts/livespec/check.py                             # living page S45 keeps its [proof:]/[code:] true
```

Expected: no FK from a `ShopFunction*` table to another domain, `ShopFunctionVersionHistory` in `db/ownership.ts`, no `@Global()` in the module, no `CheckoutDiscounts` anywhere in the tree, no direct `sequelize.transaction` and no `// S54 T037 audit` comment left in this domain, the orders barrel without the two transitional lines.

## End-to-end story (what the e2e files prove)

1. An ADMIN of an entitled shop creates `third-case-discount` with two test cases → `201`, no version, no task.
2. They submit the 3-case source → `202 QUEUED`; version, frozen cases, history row and one outbox request commit together; the consumer judges it → `ACTIVE`, caches dropped, `GET …/versions/1` shows verdicts and timeline.
3. They submit a loop and a `require('fs')` version → `REJECTED` with `timeout` / `runtime` verdicts; version 1 keeps serving.
4. Checkout: `evaluateDiscounts` for a two-shop cart → `{shopDiscounts: [{shopId: S1, discountMinor: 600}]}`.
5. Break the function five times in a minute → breaker `OPEN` (visible on `GET …/:functionId`), checkout unchanged for the buyer; after 300 s one trial closes it.
6. Downgrade the shop (double revokes the key) → function stops applying with no resubmission; regain → applies again.

## Ops artifacts (criteria no automated test proves — not run)

| Criterion | How to run it | Status |
|---|---|---|
| SC-002 checkout evaluation p95 ≤ 15 ms for one shop, one healthy function, warm cache; worst case 10 × 3 timing-out functions under 200 ms on real hardware | benchmark script `packages/backend/scripts/load-tests/shop-functions-evaluate.*` against core with a seeded active function (k6 or autocannon through a thin test endpoint, or a node loop calling the service). AS-31 proves the 200 ms bound logically in CI; the percentile on production-like hardware is not proven | not run |
| SC-004 a version is judged and readable within 5 seconds of submission when the judge is idle | submit against a running stack (core + worker + function-runner + queue relay) and time `POST …/versions` → `GET …/versions/N` showing a terminal status. CI proves the 12-minute upper bound with a frozen clock (AS-19), not the 5 s wall-clock | not run |
| SC-003 / AS-23 the deployed runner really has no egress and no credentials | in the deployed (or compose) runner container: attempt a TCP connect, read `/proc/self/environ`, write to `/`; each must fail. `check:function-runner` proves the declared profile statically, not the running container | not run |

Each row is also in `specs/UNVERIFIED.md`.
