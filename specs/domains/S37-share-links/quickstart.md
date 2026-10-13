# Quickstart: validating S37 share links

Contracts: [share-links-api.md](contracts/share-links-api.md), [events.md](contracts/events.md). Stores: [data-model.md](data-model.md).

## Prerequisites

- Test stack up (`docker-compose.test.yaml`: Redis, DynamoDB Local, Kafka stand-in, ClickHouse, PostgreSQL) with `packages/backend/dynamodb/Links.json` (table `test_Links` with the `byOwnerV2` index: a table created before S37 must be dropped and created again, DynamoDB Local leaves an index added by `UpdateTable` in `CREATING`) and `clickhouse/020_link_clicks.sql` applied (`pnpm clickhouse:migrate` against the test database; the e2e fixture also applies the DDL itself, L-011).
- Environment: `SHARE_LINK_CODE_KEY`, `SHARE_LINK_EDGE_SECRET`, `SHARE_LINK_BASE_URL` are required keys (see `env/test.env.example`); a `.env.test` copied before S37 needs them added.
- Configuration (test values are in the config mock; production values are secrets): `share_link_code_key` (≥ 32 bytes, different from `jwt_secret` and the ad click secret), `share_link_base_url` (absolute https), `share_link_edge_secret` (≥ 32 bytes; also the `SHARE_LINK_EDGE_SECRET` Worker secret of `edge-be`), `share_link_max_per_owner`, `front_host` (https origin, no path).
- **Deploy check (W02 follow-up)**: the web app's `SITE_URL` and the backend's `front_host` are the same origin: `test "$(printf %s "$SITE_URL" | sed 's:/*$::')" = "$(printf %s "$FRONT_HOST" | sed 's:/*$::')"`. The `__Host-ref` cookie is set by W02's `POST /api/attribution/ref` on that origin; S37 sets no cookie.

## Run

From `packages/backend` (L-008: batches of fresh processes; each prints a condensed result and the log path):

```bash
pnpm test -- libs/domains/marketing libs/common/config                         # unit specs U1–U5 (the e2e runner only picks up *.e2e-spec.ts)
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/marketing/share-links-create.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/marketing/share-links-redirect.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/marketing/share-links-clicks.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/marketing/share-links-manage.e2e-spec.ts
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/marketing/share-links-platform.e2e-spec.ts
pnpm --dir packages/edge-be test -- short-link                                # AS-41, AS-42
```

Expected: every file's summary line shows 0 failed; scenario → file mapping is `test-plan.md`.

## Static gates (AS-64)

```bash
pnpm --dir packages/backend exec tsc --noEmit -p tsconfig.json
pnpm --dir packages/backend check:boundaries
pnpm --dir packages/backend check:module-graph
pnpm --dir packages/backend check:model-registry
pnpm --dir packages/backend check:no-wallclock
pnpm --dir packages/backend check:table-ownership --strict    # no share-link line
python3 scripts/livespec/check.py                              # new page docs/spec/capabilities/S37-share-links.md
```

## Start the real applications (L-004, L-015)

`scripts/qa/fresh-run.sh` on an empty stack, then confirm `apps/core`, `apps/worker` (filter rebuild job registered) and `apps/projector` (consumer `link-clicks` declared) boot. Smoke: sign in, `POST /api/links` with an `Idempotency-Key`, `curl -si $BASE/api/l/<code>` shows `302` with `ref`, stats show the click after the consumer ran.

## Ops artifacts (no automated test proves these; rows in `specs/UNVERIFIED.md`, status "not run")

- The script `scripts/load-tests/share-links.test.js` and the package script `loadtest:share-links` are created by this change (T95).
- **SC-001**: p99 of cached origin redirects < 20 ms: `pnpm --dir packages/backend loadtest:share-links` (Zipf redirects at the origin); read the latency summary.
- **SC-002**: 40,000 redirects/s with the origin seeing at most one request per code per edge location per 10 s: same script, edge scenario against `wrangler dev`; compare origin request log counts with the cached-answer window.
- **SC-004** (99th-percentile part): measure `link_click_consumer_lag` p99 under load < 60 s; AS-43 and AS-60 prove exactness and immediate visibility, not the production lag.
- **SC-006** (rate part): 400 creates/s sustained in the same script; the code-space share (< 0.5% for 5 billion links) is arithmetic proven by U1.
- AS-66 (UI journey) is owned by W02 and stays pending until W02 exists. The API half (create, anonymous follow lands with `?ref=<code>`, owner's statistics show the click) is proven by `S37 AS-66` in `share-links-clicks.e2e-spec.ts`; the "Share" button and copy control are not tested (row in `specs/UNVERIFIED.md`, status "not run").
