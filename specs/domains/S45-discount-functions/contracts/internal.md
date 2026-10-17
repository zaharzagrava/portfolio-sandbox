# Contract: internal interfaces of `shop-functions`

## R1 export to orders: `DiscountEvaluationService` (AS-24 to AS-34)

Exported from `@app/domains/shop-functions` with the types below (nothing else leaves the domain: no model, repository, sandbox class, queue name or port token).

```ts
type DiscountCartDto = {
  currency: string; // three uppercase letters
  lines: { productId: string; shopId: string; category: string; quantity: number; unitPriceMinor: number }[];
};
type DiscountEvaluationDto = { shopDiscounts: { shopId: string; discountMinor: number }[] };
evaluateDiscounts(cart: DiscountCartDto): Promise<DiscountEvaluationDto>;
```

Guarantees: **never rejects** (invalid cart, store, cache, billing or sandbox failure ⇒ no discount for the affected function, shop or call); `discountMinor` is an integer with `0 < discountMinor ≤` the shop's gross; only shops with a discount, each once; one batch entitlement call (`getMany('SHOP', shopIds)`) and one batch active-set read per call; resolves within 200 ms (returns finished shops, rest `budget_exceeded`); writes nothing; seller code receives only `{currency, lines: [{productId, category, quantity, unitPriceMinor}]}` of **its own shop** (no shop id, user, name, address, email, token); largest discount per line across a shop's functions (no stacking), several discounts of one function add up, clamped to the line then to the shop's gross. Limits of the input: 1–50 lines, ≤ 10 shops, integer `quantity ≥ 1`, integer `unitPriceMinor ≥ 0`.

Orders (S10) keeps its own 250 ms timeout and `orders_discount_fallback_total{reason}`. `CheckoutDiscounts`, `DiscountableLine`, `LegacyCheckoutDiscountsAdapter`'s source binding and their transitional exports disappear in the cut-over task.

## Ports consumed (domain/ports.ts tokens; adapters in infra/)

| Port | Adapter | Notes |
|---|---|---|
| `FunctionRepository`, `VersionRepository`, `TestCaseRepository` | `pg-*.repository.ts` | every principal method takes `shopId`; the judge uses `(functionId, version)` |
| `ActiveSetCache`, `MemoCache` | `redis-*.cache.ts` | corrupt entry = miss; TTL on every key |
| `BreakerStore` | `redis-breaker.store.ts` | Lua; `admit(now) → ADMIT\|SKIP\|TRIAL`, `recordFailure`, `recordSuccess` |
| `FunctionRunner` | `runner.client.ts` | coordinator → runner over the socket; strict reply schema |
| `ShopFunctionsEntitlements` | `billing-entitlements.adapter.ts` over `EntitlementsService` | `getMany`, `has`; unknown key ⇒ not entitled (research D-13) |
| `JudgeRequests` | outbox `appendTask` | inside the submit transaction |
| `Clock` | platform clock | frozen in tests |

## Judge task and outbox

- Event `shop_functions.judge_requested`, aggregate = function id, payload `{functionId: uuid, version: int ≥ 1}` (strict zod, no extra field). Relayed to the single-consumer task `shop-functions.judge-version` (no FIFO-only option: L-001).
- Consumer: payload invalid ⇒ dead-letter with reason, no state change; function or version missing ⇒ ack, no effect; terminal state ⇒ ack, no effect; `QUEUED` ⇒ claim; `TESTING` ⇒ judge again. Concurrency 4 per worker instance.
- Queue name defined in `infra/docker/elasticmq` config (L-002); readiness fails while a consumed queue is missing.

## Job

`shop-functions.recover-stuck-versions`: schedule `* * * * *` (every 60 s), `fleetConcurrency: 1`, payload `{}` declared with `declareJobType` next to the `JobPayloads` augmentation (`application/shop-functions.job-types.ts`). Per run, versions `QUEUED`/`TESTING` with `updatedAt` older than 2 minutes: `judgeAttempts < 5` ⇒ `judgeAttempts + 1`, `updatedAt = now`, one outbox request; `judgeAttempts = 5` ⇒ `REJECTED` (`rejectionReason: judge_unavailable`, history row actor null) and no request. Registration catches `InvalidScheduleError` (log, fail start). The run also refreshes the backlog gauges.

## Runner protocol (coordinator ↔ function-runner)

Unix domain socket in a directory shared by the two containers; one connection per version; newline-delimited JSON.

Request: `{runId: uuid, source: string ≤ 20000, cases: [{name, input, expected}] ≤ 50, caseBudgetMs: 50, totalBudgetMs: 10000}`.
Reply: `{runId, verdicts: [{case, verdict, detail?, actual?, ms}]}` or `{runId, error: "budget"|"internal"}`. The coordinator parses it with a strict schema, verifies `runId`, and treats a missing, late (total + 2 s) or invalid reply as "judge unavailable" (the version stays `TESTING`; recovery re-requests). The runner holds no credential and answers only on the socket; it runs one isolate per case and destroys it after the case.

Runner container profile (checked by `pnpm --dir packages/backend check:function-runner`, AS-23): network none / no egress route, read-only root filesystem (tmpfs only for the socket directory), non-root uid, default seccomp profile (no `unconfined`), no secret or data-store variable in `environment`, CPU and memory limits set, the socket volume shared only with the coordinator service.

## Metrics (names exact; labels closed; no shop, function or product id)

`shop_functions_evaluations_total{outcome}` (`applied`, `no_discount`, `timeout`, `memory`, `runtime`, `invalid_output`, `breaker_open`, `not_entitled`, `entitlement_unavailable`, `definitions_unavailable`, `budget_exceeded`, `invalid_cart`), `shop_functions_evaluation_duration_ms` (histogram), `shop_functions_judge_total{verdict}` (`active`, `rejected`, `superseded`, `unavailable`), `shop_functions_breaker_open_total`, `shop_functions_judge_backlog`, `shop_functions_judge_oldest_queued_age_seconds`. Logs: JSON with `requestId` or `traceId`; never source, test input, discount message, token or cookie.
