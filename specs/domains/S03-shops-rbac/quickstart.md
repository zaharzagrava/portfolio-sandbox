# Quickstart: validating S03

Run from `packages/backend`. Test engines per `docker-compose.test.yaml` (Postgres, Redis, local DynamoDB for identity sessions). The non-superuser RLS probe roles are created by the specs themselves (`test/utils/tenancy-roles.ts`, idempotent); the second Postgres database for cell `dedicated-1` arrives with US7. Run `pnpm run db:jest:migrate:up` once after pulling the two `20261010140000/141000-tenancy-s03-*` migrations. Shapes: [contracts/](contracts/); tables: [data-model.md](data-model.md); decisions: [research.md](research.md). `TN` = `libs/domains/tenancy`.

## Fast loop (narrowest proof first)

```bash
# pure units (no DB): permissions, role-policy, shop-status, verification-status
pnpm jest libs/domains/tenancy/domain --testPathIgnorePatterns e2e
# one e2e file at a time (condensed output, full log path printed)
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/tenancy/shop-lifecycle.e2e-spec.ts
# the whole tenancy suite once at the end
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/tenancy
# static gates
pnpm tsc --noEmit -p . && pnpm lint && pnpm check:boundaries && pnpm check:table-ownership --strict && pnpm check:model-registry
```

## Scenario map

| Scenarios | File | Expected |
|---|---|---|
| AS-01–08 | `TN/shop-lifecycle.e2e-spec.ts` | create (rows, outbox, nothing written to users), validation classes, reserved/taken/concurrent slug, 10-shop limit under race, `mine` cursor, patch |
| AS-05, 09, 10, 12–15 | `TN/tenant-resolution.e2e-spec.ts` | 401 route table, identical 404 matrix, header/path/body tenant, status gate and answer order, cache invalidation/stale/outage, logs and events carry `shopId`/`requestId` |
| AS-11, 19, 82 | `TN/shop-roles.e2e-spec.ts` | role × endpoint outcomes, admin escalation attempts, `GET /shop-roles` |
| AS-20–27, 83 | `TN/shop-members.e2e-spec.ts` | members page with one batched directory call, role change, last owner, concurrent demotions (20 repetitions), serialization retry, self-leave, session revocation for SSO members, realtime topic |
| AS-28–39 | `TN/shop-invites.e2e-spec.ts` | digest only, outbox message with token, validation, duplicates, seats under race, accept happy/negative/concurrent/existing member, revoke, resend, list, rate limits |
| AS-40–46, 50 | `TN/shop-sso.e2e-spec.ts` | configure with the fake provider, validation and SSRF, secret keep/replace, read/delete, resolver contract, public lookup, end-to-end login through S02 |
| AS-47–49 | `TN/shop-sso-provisioning.e2e-spec.ts` | provisioning, duplicates, ignore/deny/poison, no re-add after removal |
| AS-51–56 | `TN/shop-cells.e2e-spec.ts` | directory row, admin move (race), routing, fail-closed, saturated pool bulkhead, cell cache |
| AS-57–59 | `TN/tenancy-isolation.e2e-spec.ts` | RLS with a no-bypass role incl. `WITH CHECK`, pool of one, bypass allowlist |
| AS-60 | `TN/tenancy-startup.e2e-spec.ts` | production start refuses a bypass/superuser role |
| AS-61 | `TN/tenancy-schema.e2e-spec.ts` | indexes, partial unique index, no cross-owner FK, up/down/up with lock timeout |
| AS-62, 63 | `TN/tenancy-provisioning.e2e-spec.ts` | legacy and sandbox provisioning |
| AS-65–70 | `TN/shop-offboarding.e2e-spec.ts` | suspend/reinstate, offboarding start/cancel, export, purge job, no invites while closing |
| AS-72, 73 | `TN/tenancy-consumers.e2e-spec.ts` | verification and plan consumers: duplicate, out of order, unknown, poison |
| AS-74–77 | `TN/tenancy-exports.e2e-spec.ts` | R1 services, query counters, barrel export names |
| AS-78 | `TN/tenancy-events.e2e-spec.ts` | outbox atomicity (failing trigger), envelopes, no event on rejection |
| AS-79 | `TN/tenancy-errors.e2e-spec.ts` | problem+json codes, generic 500, contract parse |
| AS-80 | `TN/shop-batch-read.e2e-spec.ts` | public batch read |
| AS-81 | `TN/tenancy-observability.e2e-spec.ts` | audit lines, counter labels |
| AS-16–18, 64, 71 | unit specs in `TN/domain/` | matrix, monotonicity, `canManage` grid, status machine, verification machine |
| AS-77 (static) | gates above | zero findings for tenancy tables once consumers migrate |

## Success criteria proven by tests

SC-001 (`tenant-resolution`), SC-002 (`tenant-resolution`, `shop-members`), SC-004 (`shop-invites` with 20 simultaneous accepts), SC-007 (`shop-sso` AS-50), SC-008 (`shop-offboarding` AS-69, rows counted after purge), SC-009 is not proven by a test in this pass: it is an Ops artifact (`check:table-ownership --strict`, expected red until the consumers listed in gaps.md section C migrate) and a `not run` row in `specs/UNVERIFIED.md`.

## Ops artifacts

Success criteria no automated test here proves. Each is also a row in `specs/UNVERIFIED.md` with status `not run`; do not describe any as verified.

- **SC-003** (200 randomized pairs of simultaneous owner demotions/removals): the e2e repeats the race 20 times (AS-23). Run the 200-pair version against the test stack: `TENANCY_RACE_PAIRS=200 /opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/tenancy/shop-members.e2e-spec.ts -t "AS-23"` and check every shop ends with ≥ 1 owner and exactly one success per pair.
- **SC-005** (create a shop and have a colleague join through an invite in under 3 minutes of interaction): needs W04's screens and a real mail transport; time the journey in `packages/web/tests/shop-team.spec.ts` plus a manual run on the staging stack.
- **SC-006** (saturating a dedicated cell leaves other shops within normal latency; moving a shop needs zero changes elsewhere): AS-54 proves only the 503 and that pooled requests answer `200` (no latency figure is asserted in the e2e); the "zero changes elsewhere" half is shown by moving a shop and running another domain's existing query unchanged; the latency budget (p95 within 1.2× the same-run baseline) under load is a k6 run deferred until shop-scoped hot endpoints exist (SD-07): hold the `dedicated-1` pool at capacity, drive pooled-shop reads at the normal rate, compare p95 against the baseline run.
