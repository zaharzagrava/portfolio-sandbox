# SD-02 — Multi-Tenant Shops (B2B SaaS for sellers)

Status: ☑ done (typechecked; spec written, not run) — noisy-neighbour k6 deferred until shop-scoped hot endpoints exist (SD-07) · Phase 1 · Depends on: F-01 (CLS), SD-39 · Used by: SD-07, 16, 25, 27, 30, 36, 38, 40, 41, 44

## Marketplace adaptation
A seller is no longer a single `User` with role SELLER: it's a **Shop** (tenant) with a team — owner, admins, staff, viewers — and plan limits. Big brands (an "Apple Store" shop) get dedicated resources; small shops share. Every shop-scoped row, cache key, S3 prefix, queue message and log line carries `shopId`.

## Existing code
`Product.sellerId`, `ChatChannel.sellerId`, `Role.SELLER`, roles guard.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| Shared schema + `shopId` on every shop-scoped table (migration: create Shop per existing seller, backfill `shopId` — **expand/contract** zero-downtime migration with batched backfill) | 10/04 #2, 03/03 §1 |
| Tenant resolution once per request (header/JWT claim/subdomain), **membership verified**, put in CLS | 10/04 #2, 02/01 §5 |
| **Postgres RLS** backstop: `USING (shop_id = current_setting('app.shop_id')::uuid)`, `SET LOCAL` per transaction (PgBouncer transaction mode safe) | 05/02 §7, 10/04 #2 |
| Context-scoped repositories (Sequelize scope auto-applying `shopId`) | 05/02 §7 Option A |
| **RBAC per membership** + permission matrix (`shop.products.write`, `shop.payouts.read`) + **ABAC** checks for record-level rules; BOLA tests (cross-tenant IDs → 404) | 05/02 §6–7 |
| Composite indexes leading with `shopId`; per-tenant unique constraints | 03/01 §3 |
| Noisy neighbours: per-shop rate limits & quotas (SD-28), fair job scheduling (SD-29) | 06/03 bulkheads |
| **Tenant directory / cell routing**: `ShopDirectory` maps shop → cell (`pooled` / `dedicated-<n>`), connection resolver picks the DB/replica — hybrid isolation model | 10/04 #2 |
| Tenant lifecycle: onboarding, plan limits, offboarding export + GDPR hard delete job | 10/04 #2 |
| Invitations (signed, single-use tokens) | 05/02 |

## Data / storage
Postgres: `Shop`, `ShopMembership(userId, shopId, role)`, `ShopInvite`, `ShopDirectory(shopId, cell, region)`; `shopId` added to `Product`, `ChatChannel`, `BisOrder` (seller side) etc.

## Steps
- [x] Migrations (expand): `Shop`, `ShopMembership`, nullable `shopId` columns + indexes `CONCURRENTLY`; backfill job (batched via SD-29); (contract) NOT NULL + RLS policies.
- [x] `libs/common/src/tenancy/` — `TenantContext`, `ShopGuard` (`X-Shop-Id` header or path `/shops/:shopId/...`), `@ShopPermission('products.write')`, RLS `SET LOCAL` hook on CLS transactions.
- [x] `ShopDirectory` + `TenantConnectionResolver` (pooled default; dedicated cell = separate Sequelize instance from config).
- [x] Shop CRUD, invites, members, roles endpoints.
- [x] Update `ProductService.create` to stamp `shopId`.
- [x] e2e: BOLA — staff of shop A gets 404 on shop B product; viewer can't write; RLS blocks raw query without context.

## Scale
- Target: 1M shops, 95% < 5 members; biggest shops 100k products, 10k RPS of their own traffic.
- Hot path: membership + permissions resolved from a Redis cache (`membership:{userId}` hash, invalidated via F-05 events) → zero DB reads per request; RLS adds no round trip (`SET LOCAL` piggybacks on the tx).
- First bottleneck & fix: one huge shop dominating the pooled DB → move it to a dedicated cell via `ShopDirectory` (no code change in domains).
- Partitioning/sharding key: `shopId` (also the future Citus/cell sharding key).
- Capacity model: pooled cell handles ~50k RPS mixed; top-10 shops by traffic get dedicated cells.
- Proof: k6 mixed-tenant load with one "noisy" shop at 10× — other shops' p99 unchanged (bulkhead proof).

## FE visualisation (phase 2)
Shop switcher, team management, roles matrix.

## Implementation notes (2026-10-01)
- Migration `20261001140000-shops-tenancy-expand`: `Shop`, `ShopMembership` (PK shop+user, index by user), `ShopInvite`, `ShopDirectory` (cell/region), `ShopSsoConfig`; nullable `shopId` on `Product`/`ChatChannel` + `CONCURRENTLY` indexes leading with `shopId`; **FORCE RLS** with `tenant_isolation` policies on shop-private tables, keyed by transaction-scoped `app.shop_id` (PgBouncer-safe).
- CONTRACT step is done by the `tenancy.backfill-shops` job (batched, self-re-enqueueing, idempotent) after the backfill reaches zero: `CHECK ... NOT VALID` → `VALIDATE` (no table-wide lock). A blocking contract *migration* was rejected because it would stop all later migrations on databases that still need the backfill.
- `libs/common/src/tenancy/`: permission matrix (`satisfies`), `MembershipService` (cached, negative-cached, invalidated on change), `ShopGuard` + `@ShopScoped(permission)` (404 for non-members, CLS shopId/roles), `ShopTransactionRunner` (`inShop` sets RLS tenant; `crossTenant(reason)` audited bypass), `TenantConnectionResolver` (pooled vs dedicated cells via `ShopDirectory` + `TENANT_CELLS`), `ShopService` (create with owner + directory, invites hashed single-use, accept via audited bypass, **"≥1 owner" invariant under SERIALIZABLE + retry** against write skew), `ShopSsoService` (encrypted client secret; dynamic `shop:<id>` OIDC providers via `OidcService.setResolver`), `ShopController`.
- Products: `POST /api/products/shops/:shopId` (`products.write`) stamps `shopId`.
- `TenancyModule` in `core`; `TenancyWorkerModule` (backfill job) in `apps/worker`. `SeedsService.clean()` deletes shops.
- Spec `tenancy/tenancy.e2e-spec.ts`: BOLA 404s, invite/accept/permissions, concurrent owner demotion (write skew), RLS invisibility, immediate membership revocation.
