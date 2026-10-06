# SD-40 — Shop Functions: Seller Code in a Sandbox (Online judge adaptation)

Status: ☑ done (typechecked; specs written, not run) · Phase 6 · Depends on: SD-02, SD-19, SD-03 · DOUBTS Q4

## Marketplace adaptation
Pro shops write small **JavaScript functions** for custom discounts ("buy 2 cases, 3rd is 50% off", "bundle price") — like Shopify Functions. Code is untrusted: it runs in a sandbox, is tested against seller-provided test cases before activation, and executes at checkout within a strict time budget.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Submission → QUEUED → compile/test in runner → ACTIVE/REJECTED (like a judge: test cases, verdicts) | 10/09 #40 |
| **Isolation**: `isolated-vm` (separate V8 isolate, memory limit, CPU timeout, no Node APIs) — `vm` explicitly rejected (not a sandbox) — plus process-level isolation: runner pool in a separate container with no network, read-only FS, non-root, seccomp (documented + docker config) | 05/01 §7.6, 10/09 #40 |
| Pure function contract: input = cart JSON, output = discount ops validated by zod (never trust output) | 01/02 §8 |
| Checkout path budget: 5 ms per function, fallback = no discount on timeout (fail-safe), circuit-breaker per function | 06/03 |
| Compiled function cache (isolate snapshots / compiled scripts) keyed by version hash | — |
| Runner autoscaling on queue depth for test runs; pre-warmed isolate pool for checkout | 10/09 #40 |

## Steps
- [x] `ShopFunction`, `ShopFunctionVersion`, `ShopFunctionTestRun` models.
- [x] `apps/function-runner/` with `isolated-vm` pool; test-run worker (SQS).
- [x] Checkout integration: apply active functions with timeout + validation.
- [x] e2e: infinite loop → killed at timeout, version REJECTED; `require('fs')` → ReferenceError; valid discount applied at checkout.

## Scale
- Target: checkout 10k RPS × up to 3 functions → 30k executions/s at ≤ 5 ms → ~150 CPU cores worst case; pre-compiled scripts + pooled isolates; results memoised per (function version, cart hash) for 60 s.

## Implementation notes (2026-10-02)
- **Dependency:** `isolated-vm` 7 (prebuilt binaries, no build scripts needed).
- **`FunctionSandbox`:**
  - One V8 isolate per function version (32 MB cap), compiled once per source hash (LRU 200), with a wall-clock timeout; JSON-string copies cross the boundary; no Node APIs.
  - Isolates are disposed after a timeout or OOM.
  - **Verified locally:** an infinite loop is killed at 24 ms on a 20 ms budget; `require`/`process`/`fetch` are "not defined"; a memory bomb kills only its isolate (51 ms) and the host keeps working.
  - `node:vm` is rejected (not a sandbox).
- **`contract.ts`:** input is one shop's lines only (no PII); the output is zod-validated, then **clamped by the host** (percentages ≤ 100, prices ≥ 0).
- **Judge:** migration `20261002150000-shop-functions` adds `ShopFunction`, `ShopFunctionVersion` (QUEUED → TESTING → ACTIVE/REJECTED/SUPERSEDED, with per-case verdicts) and `ShopFunctionTestCase`. Submit enqueues `function-test-runs`; the `FunctionJudgeModule` worker runs every case with a 50 ms budget. Only an all-pass version becomes ACTIVE; rejected versions never replace the active one.
- **Checkout:** new optional port `orders/checkout-discounts.port.ts` (`CheckoutDiscounts`), injected `@Optional()` into `CheckoutService`, so orders doesn't depend on functions and has no behaviour change when nothing is registered.
  - `ShopFunctionsService.unitPrices` runs each shop's active functions on that shop's lines, 5 ms each, memoised 60 s per (version hash, input hash).
  - Any failure → catalogue price (fail-safe), plus a per-function breaker (5 failures/min → skipped for 5 min). Flash-sale lines keep their drop price.
- **Process-level isolation for production** (second wall): the judge runs as its own image (`apps/function-runner` deployable) with no network egress, a read-only root FS, a non-root user and the seccomp default profile (O-02/O-03).

## Test plan
| Scenario | API e2e | UI journey (web) | Unit |
|---|---|---|---|
| Seller writes a function, tests pass → ACTIVE → discount at checkout | `shop-functions.e2e-spec.ts` | web: editor → "tests passed" → checkout shows the discount (happy path) | `sandbox.spec.ts` |
| Infinite loop / Node API access → REJECTED with verdicts | `shop-functions.e2e-spec.ts` | — | `sandbox.spec.ts` |
| Memory bomb contained | — | — | `sandbox.spec.ts` |
| Invalid/malicious output validated + clamped | — | — | `sandbox.spec.ts` |
| Function only sees/affects its own shop's lines | `shop-functions.e2e-spec.ts` | — | — |
| Runtime failure at checkout → catalogue price + breaker | `shop-functions.e2e-spec.ts` | — | — |
