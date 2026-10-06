# Research & Decisions: Phase 2 Batch 2

## R1. Event contracts go in `application/events/` {#r1}

- **Decision**: `order-events.ts`, `ledger-events.ts`, `chat-events.ts`, `pickup-events.ts`,
  `courier-events.ts`, and `onboarding-events.ts` → `<domain>/application/events/`.
- **Rationale**: each one calls `defineEvent` from `@app/infrastructure/events` (it wraps zod plus
  OpenTelemetry context). I.3 forbids infrastructure imports in `domain/`. `application/` may use
  infrastructure libs (X.5), and these are the contracts the domain publishes through its barrel
  (X.4).
- **Alternatives considered**: `domain/` (violates I.3); `infra/` (wrong meaning, because these
  are public contracts, not adapters); moving `defineEvent` to `common` so events can be pure
  (worth doing later, since it would let event schemas live in `domain/`, but it changes the
  infrastructure surface and is out of scope).

## R2. Fix the barrel cycle at its source, not with `forwardRef` {#r2}

- **Observation**: the require-stack trace at the failing load was:
  `collab-app.module → catalog/index → catalog/infra/models/product.model → identity/index →
  identity/users.module → infrastructure/stripe/stripe.module → stripe.service → payments/index →
  payments/infra/models/ledger-entry.model → payment.model → orders/index → orders-worker.module →
  order.jobs → orders/application/checkout.service`.
  `checkout.service` evaluates `@InjectModel(Product)` while `catalog/index` is still on its first
  export, so `Product` is `undefined`.
- **Decision**: remove the infrastructure → domain edges that close the loop:
  - `Domain_CircuitBreakerOpenError` → `infrastructure/stripe/stripe.errors.ts`. Stripe is its only
    user, its text is Stripe-specific, and it extends the common `AppError`.
  - Drop `UserUtilsModule` from `StripeModule.imports`. `StripeService` doesn't inject it, and
    Nest modules don't re-export imports implicitly, so no consumer could have depended on it
    through `StripeModule`.
- **Rationale**: the edge was already illegal (X.3: infrastructure never imports domains). Fixing
  it removes the cycle and pays debt. `forwardRef` would only hide the cycle, and the constitution
  bans it (PR gate 1, IV.2).
- **Verification**: the module graph is 9/9. The only change in visited nodes is the removal of
  `UserUtilsModule` and `UserUtilsService` from payment-processor and worker (−2 each).
  `UserUtilsService` has no constructor or lifecycle hooks, so not instantiating it there has no
  effect.

## R3. Merge into barrels instead of regenerating them {#r3}

- **Decision**: `phase2-entrypoints.ts` reads each existing `index.ts`'s exports through the
  checker. It appends only missing names and skips unchanged barrels.
- **Rationale**: after batch 1, nothing deep-imports identity, tenancy, or catalog anymore.
  Regenerating from deep usage would have emptied those barrels. Appending also keeps hand-made
  edits.

## R4. Order export moves now; its route moves later {#r4}

- **Decision**: move only `order-export.service.ts` into `orders/application/`. `CatalogImportModule`
  keeps providing it and serving its routes through the orders barrel.
- **Rationale**: this is the one class that queries `ExportJob`, so IX.4 data ownership is right
  immediately. Moving the routes and queue consumer changes the HTTP and worker topology, which
  needs e2e changes and is tracked as D-10.

## R5. No registry edits needed {#r5}

- **Decision**: leave `db/ownership.ts` unchanged.
- **Rationale**: batch 1 deliberately registered all 100 tables, including orders, payments, chat,
  fulfilment, and seller-onboarding. What batch 2 adds is enforcement: the placement check now
  covers the 11 models that moved, and it passes. Tables without models (e.g. `PickupPoint`,
  `Courier`, `ShopDocument`, `ReviewTask`, raw SQL) are covered by completeness checks. The future
  IX.5 query check will cover them by SQL.
