# Quickstart: validating S48

Prerequisites: `docker-compose.test.yaml` Redis running (the BFF has no Postgres); run backend commands from `packages/backend`. Contracts: [contracts/http.md](contracts/http.md); records: [data-model.md](data-model.md); scenario mapping: [test-plan.md](test-plan.md).

```bash
pnpm test libs/composition libs/common/config           # unit specs: U1 limits, U2 batching, U3 breaker, U4 gate, U5 cache policy,
                                                        # U6 CSRF MAC, U7 lifetime, config, contracts, legacy-header gate
S=/opt/sdd/repo/scripts/sdd/test-spec.sh                # e2e specs only (`*.e2e-spec.ts`)
$S libs/composition/bff/upstream                        # upstream client over the stub origin
$S libs/composition/bff/bff.e2e-spec.ts                 # P  AS-01..AS-24
$S libs/composition/bff/bff-graphql.e2e-spec.ts         # G  AS-25..AS-42
$S libs/composition/bff/bff-session.e2e-spec.ts         # S  AS-43..AS-63
$S libs/composition/bff/bff-boundary.e2e-spec.ts        # B  AS-39, AS-63 startup, AS-64
pnpm exec tsc --noEmit                                  # also in packages/contracts and packages/web
pnpm check:boundaries
pnpm check:table-ownership
pnpm check:table-ownership --strict                     # expected: no line names composition
pnpm check:no-request-scope
```

Whole capability once at the end: `$S libs/composition/bff`.

## Smoke (local, stubbed upstreams)

1. Start the stubs and the BFF with `BFF_UPSTREAM_URL` pointing at them (the process refuses to start without it) and `BFF_LOCAL_DEV=true` for ad-hoc GraphQL text.
2. `GET /api/bff/product-page/<uuid>` with `X-Anonymous-Id: anon_12345678` → `200`, `Cache-Control: private, no-store`, `chatUnread: null`, `errors: []`.
3. Slow one stub to 2 s → the page still answers within about 1.1 s, that section `null` with `UPSTREAM_TIMEOUT` or `BUDGET_EXCEEDED`.
4. `POST /api/bff/session` with an allowed `Origin` → `Set-Cookie` for `__Host-bff-session` (HttpOnly) and `__Host-bff-csrf`; no token in body or cookies; `GET /api/bff/session` → user; `POST …/logout` without `X-CSRF-Token` → `403`, with it → `204`.
5. `POST /api/graphql` with `{"extensions":{"persistedQuery":{"sha256Hash":"<known>"}}}` → data; an unknown hash → `PERSISTED_QUERY_NOT_FOUND`.

## Ops artifacts (no automated test proves these; rows in `specs/UNVERIFIED.md`, status "not run")

- **SC-008**: load profile "50k page requests per second, one optional dependency slowed to 2 s" (`loadtest:product-page`, k6, against a deployed BFF with stub or staging upstreams). Pass when every request completes within the 1-second page deadline and the slowed dependency's breaker opens within 10 s (`bff_breaker_state` gauge, `CIRCUIT_OPEN` in `errors`). Not an e2e scenario; the single-instance behaviour (breaker, deadline) is proven by AS-12, AS-16, AS-17, the throughput claim is not.

SC-001 to SC-007 and SC-009 are proven by the scenarios they cite (SC-001 AS-12/AS-16; SC-002 AS-25/AS-27; SC-003 AS-31–AS-34; SC-004 AS-37; SC-005 AS-43/AS-23 log scan and the session suite; SC-006 AS-54; SC-007 AS-44/AS-58/AS-59/AS-42; SC-009 AS-15, AS-30 and the section table). They are not ops artifacts.

## Configuration to set (all validated at startup; the process stops on a missing or malformed value)

`BFF_UPSTREAM_URL` (no default), `BFF_SESSION_KEYS` (1–2 base64 32-byte keys, first encrypts), `BFF_CSRF_KEY`, `BFF_ALLOWED_ORIGINS`, `trusted_proxies`, optional overrides of every budget and limit in spec Assumptions, `BFF_LOCAL_DEV` (only for local ad-hoc GraphQL). Redis for sessions must not use an `allkeys-*` eviction policy.
