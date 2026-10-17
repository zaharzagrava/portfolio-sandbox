# Quickstart: validating S06 — Collaborative listing drafts

Run from `packages/backend`. Use the condensed runner; open its full log only when the summary is not enough.

## Prerequisites

- Test engines up (`docker-compose.test.yaml`: Postgres, Redis, DynamoDB Local, MinIO, event stream); migrations applied by the harness (`…-catalog-s06-expand`, then `…-contract`). Production order: expand → code → contract.
- Config keys (validated at startup): `collab_ticket_key`, `collab_origin_allowlist`, `collab_public_url`, `collab_instance_id`.

## Narrowest proofs, in work-package order

```bash
S=/opt/sdd/repo/scripts/sdd/test-spec.sh
npx jest libs/domains/catalog/domain/draft-status libs/domains/catalog/domain/listing-doc libs/domains/catalog/domain/frame-policy libs/domains/catalog/domain/hash-ring   # WP-1: AS-45, AS-39 (fast-check), AS-11/34, AS-19/22
$S libs/domains/catalog/drafts-api            # WP-2: AS-01…AS-11
$S libs/domains/catalog/drafts-publish        # WP-3: AS-28…AS-39
$S libs/domains/catalog/draft-versions        # WP-4: AS-40…AS-44
$S libs/domains/catalog/collab-rooms          # WP-5/6/7: AS-12…AS-25
$S libs/domains/catalog/drafts-consumers      # WP-7: AS-26, AS-27
$S libs/domains/catalog/collab-routing        # WP-6/9: AS-46…AS-53
$S libs/domains/catalog/collab-ops            # WP-8/10: AS-54…AS-56
```

Whole capability once at the end: `$S libs/domains/catalog` (S05 specs must stay green).

## Static gates

```bash
npx tsc --noEmit -p tsconfig.json && (cd ../contracts && npx tsc --noEmit)
pnpm lint
pnpm check:boundaries
pnpm check:table-ownership --strict     # expected: 0 `catalog` draft findings (3 reconstructed in gaps.md C)
python3 /opt/sdd/repo/scripts/livespec/check.py
```

Numbers to record in the final report: `check:table-ownership` draft findings before → after; direct `sequelize.transaction` sites in S06 files (0 → 0).

## Ops artifacts (no automated test proves these; status "not run")

- SC-001: 50 editors typing in one draft, 99% of edits visible to all others within 100 ms — k6/ws load script against a deployed `apps/collab` (the e2e proves ordering and convergence, not the latency at 50 editors under load).
- SC-004: publish of a ≤ 20 KB draft under 2 s at p95 — load run of `POST …/publish` on a real stack (the e2e proves exactly-once, not the percentile).
- SC-007: 100,000 open drafts / 50 editors / 20,000 updates per second fleet-wide, ~5,000 rooms per instance — fleet soak on the VPS runner (room memory and event-loop lag per instance).

Rows are in `specs/UNVERIFIED.md`. SC-002, SC-003, SC-005, SC-006, SC-008 and SC-009 are proven by the e2e and unit files named in test-plan.md.
