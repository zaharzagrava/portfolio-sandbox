# Test Plan: S03 — Shops as Tenants (domain `tenancy`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario.

- API e2e files live in `packages/backend/libs/domains/tenancy/`. Each file's top-level `describe` names its feature (VII.8). They boot the real `TenancyModule` (plus the identity modules it needs, the outbox, the rate limiter and the cache) with the production pipe, filter, prefix and interceptors, against real Postgres (migrated; a **non-superuser application role** plus a probe role for RLS cases), Redis and the session store (docker-compose.test.yaml), with a second Postgres database as the `dedicated-1` cell. They freeze time with the shared clock helper, reset state in `beforeEach`, seed through the shared fixture helpers (`createUser`, `createShop(owner, { plan })`, `addMember`, `createInvite`), and assert the response **and** the persisted state (rows, cache keys, outbox rows, emitted messages) in every test.
- Only system-edge dependencies are faked: the **fake OIDC provider** of S02 (`test/fakes/fake-oidc-provider.ts`, with discovery delays, wrong issuer, hung endpoint), the SSRF guard's DNS resolver (guard itself is real), the mail transport (S28's consumer is not under test here; the `tenancy.invite_requested` message is read from the outbox), and the clock. Repositories, stores, the secret box, the identity directory and the session revocation service are real. Fault injection uses real Postgres triggers created by the test (raise `40001`, fail an insert into the outbox).
- Consumers (`identity.federated_identity_linked`, `shop.*`, `billing.subscription_plan_changed`) are driven by delivering real envelopes to the real consumer entry point; each has the duplicate-delivery and invalid-payload tests of VII.4 (rows AS-47, AS-48, AS-72, AS-73).
- Unit specs sit beside the code under `domain/`, are table-driven (`it.each`), and exist only for pure logic (VII.5): permission matrix, `canManage`, shop status machine, verification state machine. No unit tests for controllers, repositories or glue.
- UI journeys: `packages/web/tests/shop-team.spec.ts` (Playwright, owned by W04) — three happy paths for S03 only; no edge case is re-tested there.
- Static gates (VII.1): `tsc --noEmit` and ESLint for `packages/backend`; `pnpm check:boundaries`; `pnpm check:table-ownership --strict` (tenancy lines and every table of tenancy must be 0, see AS-77); `pnpm check:model-registry`.
- k6 noisy-neighbour load (SD-02 Proof) stays deferred until shop-scoped hot endpoints exist (SD-07); the bulkhead is proven here by AS-39 and AS-54.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 create shop: body, rows, outbox, nothing written to users | `shop-lifecycle.e2e-spec.ts` | `shop-team.spec.ts` (create shop, appears in switcher) | — |
| AS-02 create validation classes (name, slug, unknown field, region) | `shop-lifecycle.e2e-spec.ts` | — | — |
| AS-03 reserved slugs, `slug_taken`, concurrent same slug | `shop-lifecycle.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-04 10-shop limit, concurrent at 9 | `shop-lifecycle.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-05 401 on every endpoint | `tenant-resolution.e2e-spec.ts` (route table) | — | — |
| AS-06 get shop with `myRole`/`myPermissions`, contract parse | `shop-lifecycle.e2e-spec.ts` | — | — |
| AS-07 `mine` cursor pagination, tampered cursor, limit cap | `shop-lifecycle.e2e-spec.ts` | — | — |
| AS-08 patch name, immutable fields, permission | `shop-lifecycle.e2e-spec.ts` | — | — |
| AS-09 cross-tenant BOLA matrix: identical 404 for other, unknown, malformed | `tenant-resolution.e2e-spec.ts` | — | — |
| AS-10 header vs path vs body tenant | `tenant-resolution.e2e-spec.ts` | — | — |
| AS-11 role × endpoint outcomes | `shop-roles.e2e-spec.ts` (table-driven over routes) | — | — |
| AS-12 `SUSPENDED` / `DELETING` / `DELETED` gate and answer order | `tenant-resolution.e2e-spec.ts` | — | — |
| AS-13 cache invalidation, stale-entry race, sensitive strong read, cache outage fallback | `tenant-resolution.e2e-spec.ts` (frozen clock, Redis stopped for the outage case) | — | — |
| AS-14 `shopId` and `requestId` in logs and events, no secrets | `tenant-resolution.e2e-spec.ts` (captured log stream) | — | — |
| AS-15 foreign invite/member IDs under another shop's path | `tenant-resolution.e2e-spec.ts` | — | — |
| AS-16 permission matrix | — | — | `domain/permissions.spec.ts` (`it.each` role × permission) |
| AS-17 role monotonicity | — | — | `domain/permissions.spec.ts` (`fast-check` property) |
| AS-18 `canManage` table | — | — | `domain/role-policy.spec.ts` (`it.each` 4 × 4 × 4) |
| AS-19 admin escalation attempts over HTTP | `shop-roles.e2e-spec.ts` | — | — |
| AS-20 members list, batched e-mail lookup, SSO member without e-mail | `shop-members.e2e-spec.ts` | — | — |
| AS-21 role change: happy, no-op, unknown member, invalid role | `shop-members.e2e-spec.ts` | `shop-team.spec.ts` (owner changes a role) | — |
| AS-22 last owner: self-demote, self-remove | `shop-members.e2e-spec.ts` | — | — |
| AS-23 concurrent demotions / remove-vs-demote | `shop-members.e2e-spec.ts` (`Promise.all`, 20 repetitions) | — | — |
| AS-24 serialization retry and exhaustion | `shop-members.e2e-spec.ts` (trigger raising `40001`) | — | — |
| AS-25 self-leave and viewer removing others | `shop-members.e2e-spec.ts` | — | — |
| AS-26 SSO member removal revokes sessions; others keep theirs | `shop-members.e2e-spec.ts` | — | — |
| AS-27 removed member refused on `shop:<id>:live` | `shop-members.e2e-spec.ts` | — | — |
| AS-28 invite created: body, digest only, outbox message, no token in logs | `shop-invites.e2e-spec.ts` | — | — |
| AS-29 invite validation classes | `shop-invites.e2e-spec.ts` | — | — |
| AS-30 already member, pending, expired re-invite | `shop-invites.e2e-spec.ts` | — | — |
| AS-31 seat limit, concurrent last seat, plan raise and lowering | `shop-invites.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-32 accept happy path | `shop-invites.e2e-spec.ts` | `shop-team.spec.ts` (invite, open link, accept, see the shop) | — |
| AS-33 accept negatives all `404 invite_not_found` | `shop-invites.e2e-spec.ts` (frozen clock) | — | — |
| AS-34 concurrent accept of one token | `shop-invites.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-35 accept as existing owner keeps role | `shop-invites.e2e-spec.ts` | — | — |
| AS-36 revoke: happy, repeat, accepted, foreign | `shop-invites.e2e-spec.ts` | — | — |
| AS-37 resend: new token, old dead, illegal states | `shop-invites.e2e-spec.ts` | — | — |
| AS-38 list invites by derived status, no secrets, permission | `shop-invites.e2e-spec.ts` (frozen clock) | — | — |
| AS-39 per-shop invite limit and per-user accept brute-force limit, bulkhead | `shop-invites.e2e-spec.ts` | — | — |
| AS-40 SSO configure: sealed with shop context, registry invalidated, owner only | `shop-sso.e2e-spec.ts` | — | — |
| AS-41 SSO validation: scheme, SSRF, mismatch, unreachable, timeout, role, size | `shop-sso.e2e-spec.ts` (fake provider) | — | — |
| AS-42 SSO update keeps/replaces secret, idempotent replay | `shop-sso.e2e-spec.ts` | — | — |
| AS-43 SSO read has no secret; permissions; 404s | `shop-sso.e2e-spec.ts` | — | — |
| AS-44 SSO disable deletes secret, provider unknown, repeat | `shop-sso.e2e-spec.ts` | — | — |
| AS-45 resolver contract for `shop:<uuid>` | `shop-sso.e2e-spec.ts` | — | — |
| AS-46 public lookup by slug, uniform 404, 429 | `shop-sso.e2e-spec.ts` | — | — |
| AS-47 provisioning: happy, duplicate delivery, second event | `shop-sso-provisioning.e2e-spec.ts` | — | — |
| AS-48 provisioning ignored / denied / poison | `shop-sso-provisioning.e2e-spec.ts` | — | — |
| AS-49 redelivery after removal does not re-add | `shop-sso-provisioning.e2e-spec.ts` | — | — |
| AS-50 SSO login end to end through S02's engine | `shop-sso.e2e-spec.ts` (real registry, fake provider) | — | — |
| AS-51 directory row at creation, `cellOf` | `shop-cells.e2e-spec.ts` | — | — |
| AS-52 admin move: happy, authorization, unknown cell, stale version, race | `shop-cells.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-53 routing to cell, fail-closed on unknown cell | `shop-cells.e2e-spec.ts` | — | — |
| AS-54 dedicated pool exhausted, pooled shops unaffected | `shop-cells.e2e-spec.ts` | — | — |
| AS-55 cell cache: no query on repeat, dropped on move, lost-invalidation bound | `shop-cells.e2e-spec.ts` (query counter, frozen clock) | — | — |
| AS-56 region shown, changes only by move | `shop-cells.e2e-spec.ts` | — | — |
| AS-57 RLS per table with a no-bypass role, `WITH CHECK` | `tenancy-isolation.e2e-spec.ts` | — | — |
| AS-58 pool of one: tenant context never leaks across transactions | `tenancy-isolation.e2e-spec.ts` | — | — |
| AS-59 bypass allowlist, counter, reset after transaction | `tenancy-isolation.e2e-spec.ts` | — | — |
| AS-60 startup refuses a superuser/bypass role in production mode | `tenancy-startup.e2e-spec.ts` | — | — |
| AS-61 indexes, unique constraints, no cross-owner FK, migrations up/down/up with lock timeout | `tenancy-schema.e2e-spec.ts` | — | — |
| AS-62 legacy seller provisioning: idempotent, concurrent, batch cap, rollback | `tenancy-provisioning.e2e-spec.ts` | — | — |
| AS-63 sandbox shop provisioning and hiding | `tenancy-provisioning.e2e-spec.ts` | — | — |
| AS-64 shop status machine, every pair | — | — | `domain/shop-status.spec.ts` (`it.each`, `assertNever`) |
| AS-65 admin suspend/reinstate, illegal transitions, race with offboarding | `shop-offboarding.e2e-spec.ts` (`Promise.all`) | — | — |
| AS-66 offboarding start: happy, confirmation, permission, replay | `shop-offboarding.e2e-spec.ts` | `shop-team.spec.ts` (owner closes the shop, sees the grace banner) | — |
| AS-67 cancel offboarding | `shop-offboarding.e2e-spec.ts` | — | — |
| AS-68 export contents and permissions | `shop-offboarding.e2e-spec.ts` | — | — |
| AS-69 purge job: due vs not due, tombstone, slug reuse, sessions, idempotent, concurrent, per-shop isolation | `shop-offboarding.e2e-spec.ts` (frozen clock) | — | — |
| AS-70 no invites or provisioning while suspended/closing | `shop-offboarding.e2e-spec.ts` | — | — |
| AS-71 verification state machine, every pair | — | — | `domain/verification-status.spec.ts` (`it.each`) |
| AS-72 verification consumers: duplicate, out of order, unknown, poison | `tenancy-consumers.e2e-spec.ts` | — | — |
| AS-73 plan consumer: version guard, duplicate, poison, downgrade effect | `tenancy-consumers.e2e-spec.ts` | — | — |
| AS-74 `assertMember` | `tenancy-exports.e2e-spec.ts` | — | — |
| AS-75 `getShopsByIds`: DTO, batch cap, one query | `tenancy-exports.e2e-spec.ts` (query counter) | — | — |
| AS-76 `getMembersByShopIds`: one query, role filter | `tenancy-exports.e2e-spec.ts` (query counter) | — | — |
| AS-77 ownership and boundary checks, barrel without models | `pnpm check:table-ownership --strict` and `pnpm check:boundaries` (static gate in CI), plus `tenancy-exports.e2e-spec.ts` asserting the barrel's export names | — | — |
| AS-78 outbox atomicity on every mutation, envelope fields, no event on rejection | `tenancy-events.e2e-spec.ts` (trigger failing the outbox insert) | — | — |
| AS-79 problem+json codes, generic 500, contract parse | `tenancy-errors.e2e-spec.ts` | — | — |
| AS-80 public batch read | `shop-batch-read.e2e-spec.ts` | — | — |
| AS-81 audit lines and metric labels | `tenancy-observability.e2e-spec.ts` | — | — |
| AS-82 `GET /shop-roles` | `shop-roles.e2e-spec.ts` | — | — |
| AS-83 realtime topic policy | `shop-members.e2e-spec.ts` | — | — |

Async consumers (VII.4): every consumer named above is covered by a duplicate-delivery row and an invalid-payload row (AS-47/AS-48, AS-72, AS-73). The producers' events are consumed and tested by S01 (promotion), S28 (mail), S51 (subscription closing) and the shop-owning domains (purge); the event envelopes are asserted here (AS-78).
