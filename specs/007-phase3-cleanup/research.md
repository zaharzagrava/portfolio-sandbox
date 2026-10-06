# Research & Decisions: Phase 3

## R1. The payment-processor boot failure (found in step 5) {#r1}

- **How it surfaced.** The new `check:model-registry` loads each app in its **own** process. In that setting
  payment-processor threw `CircularDependencyException` in `@InjectModel()` at
  `orders/api/stripe-webhook.controller.ts`.
- **The cycle.** `payments/index` → `payment.model` → `orders/index` → `orders.module` →
  `stripe-webhook.controller` → `@InjectModel(Payment)` runs while `payments/index` hasn't exported anything
  yet.
- **Why it was missed.** `check-module-graph.ts` loaded all 9 apps sequentially in **one** process. When
  payment-processor's turn came, earlier apps had already loaded orders and payments in a different order.
- **It's pre-existing.** I loaded payment-processor at the committed `phase 2` tree in a throwaway git
  worktree, and it failed the same way. The bug came in with the Phase 2 orders/payments barrels. Earlier
  plans called D-11 "runtime-safe"; those plans now carry a correction.
- **Fix, at the source, no `forwardRef`.** Every runtime use of the other domain's symbols in
  `payment.model.ts` and `bis-order.model.ts` was already lazy: association arrows, and the scope factory
  that runs at query time. Only the top-level `import` was eager. So:
  - types use `import type` (erased);
  - values are read through `const orders = () => require('@app/domains/orders')` (and the mirror for
    payments), so loading a model file never loads the other barrel.
- **Prevention.** `check-module-graph.ts` now spawns one process per app, which matches how each app boots
  in production.
- **The cycle itself remains (D-11).** It's now a file-level cycle that dependency-cruiser reports.

## R2. `SeedsModule` in production `CoreModule` {#r2}

- `CoreModule` imported `SeedsModule`. No controller or service in core injects `SeedsService`, which has
  no lifecycle hooks.
- With `autoLoadModels`, `SeedsModule.forFeature([...])` registered 7 models in core. A walk of core's
  module graph showed 6 of them are also registered by their owning modules. The 7th, `Migration`, was
  registered only by `SeedsModule`, and nothing in core uses it (only `SeedsService` does).
- **Decision:** remove it. Production may not import `test/` (the new `x6` rule), and nothing observable
  changes. Core's node count drops by exactly 2.

## R3. Topic registry semantics (D-3) {#r3}

- Validation reproduces the former regex exactly:
  - topic shape is `prefix:[A-Za-z0-9_-]{1,64}` plus an optional `:suffix`;
  - the suffix may be any **registered** suffix (the old pattern allowed `:live` or `:seatmap` after any
    prefix);
  - a singleton is matched exactly (`flags`; `flags:x` stays invalid).
- Several definitions per prefix are OR-combined. This replaces the single `UNION ALL` query over
  `ImportJob` and `ExportJob`: each domain now queries only its own table.
- **Ownership** goes to the domain whose table the policy reads:
  - `shop:{id}:live` → tenancy (`ShopMembership`), using the same uncached query, not the cached
    `MembershipService`, so revocation timing doesn't change;
  - `chat` → chat; `delivery` → fulfilment; `job` → catalog-sync + orders;
  - `user` → identity; `auction` → auctions; `event`, `queue`, `stream` → launch-events; `flags` →
    experimentation.
- **Proof:**
  - `topic-registry.spec.ts` uses the old regex as an oracle for 22 topics, plus policy and OR cases.
  - A metadata walk confirms the gateway now loads 9 topic modules.
  - The `topic-stream` e2e spec loads the topic modules its tests subscribe to.

## R4. Batch reads (D-4) {#r4}

Each half moved to the domain that owns its table, with byte-identical SQL, headers, and `@Firewall`. Each
got its own small module that **only core imports**. Putting the controllers into `TenancyModule` /
`ProductModule` would have exposed `/batch/*` in every app that imports those modules (public-api, collab,
worker, …). A metadata walk listed the `batch` routes per app: core and local-monolith only, as before.

## R5. Why dependency-cruiser needed a `packageExtensions` entry {#r5}

dependency-cruiser parses through the TypeScript compiler but doesn't declare it as a peer. pnpm therefore
resolved the workspace root's TypeScript 7.0.2, which dependency-cruiser 18 doesn't support ("Install
typescript to get better results"). Declaring `typescript: '>=5 <7'` as its peer in `pnpm-workspace.yaml`
(pnpm 10+ reads settings there, not from `package.json`) links the backend's 5.9.3 instead. Verified by
resolving `typescript` from dependency-cruiser's real path. The peer warnings that `pnpm install` prints are
pre-existing (`@nestjs/common` and others), not from this change.

## R6. Boundary rules and the 5 errors they found {#r6}

- **Rules.** X.1 (nothing imports `apps/`), production ↛ `test/`, infrastructure ↛ domains/composition,
  common ↛ infrastructure/domains/composition, composition ↛ domains plus the X.8.4 infrastructure
  allowlist, domains ↛ composition, and X.4 entry points (outside a domain, and domain-to-domain). Cycles
  are `warn`.
- **The first run found 5 errors**, all `common` → `infrastructure`:
  - `platform` wired the health and context modules;
  - `lifecycle` drove readiness;
  - `logging` read `AppClsStore`.

  By the X.7 placement test, platform and lifecycle are infrastructure, so they moved. The request-context
  contract is pure types, so it moved to `libs/common/request-context`, and the CLS machinery stays in
  infrastructure.
- **Cycle warnings (62).**
  - 59 run through the known component: orders ↔ payments (D-11, including the lazy accessors), and
    catalog ↔ discovery ↔ experimentation ↔ orders (D-12, D-15).
  - 3 are inside a single lib: two mutually associated model pairs, and rate-limit decorator ↔ interceptor.
    They're recorded as D-17.
- **The rules work.** Injecting a deep domain import, an infrastructure → domain import, and a production →
  `test/` import produced exactly those 3 errors.
