# Quickstart: validating S26

Prerequisites: `docker-compose.test.yaml` services running (PostgreSQL, Redis, ScyllaDB, Kafka stand-in); migrations applied with `pnpm --dir packages/backend test:stack:migrate` (includes `cql:migrate`, so `062_feed_s26.cql` is applied). Run backend commands from `packages/backend`. Contracts: [follow-feed-api.md](contracts/follow-feed-api.md), [events.md](contracts/events.md); entities: [data-model.md](data-model.md); decisions: [research.md](research.md).

```bash
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/community/domain            # unit specs (merge, cursor, item-rules, version-guard)
/opt/sdd/repo/scripts/sdd/test-spec.sh follow-graph
/opt/sdd/repo/scripts/sdd/test-spec.sh feed-items
/opt/sdd/repo/scripts/sdd/test-spec.sh feed-read
/opt/sdd/repo/scripts/sdd/test-spec.sh feed-celebrity
/opt/sdd/repo/scripts/sdd/test-spec.sh feed-rebuild
/opt/sdd/repo/scripts/sdd/test-spec.sh feed-fanout
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/community/discussions        # S25 still green (shared domain files)
pnpm check:boundaries
pnpm --dir packages/backend check:table-ownership --strict   # zero community lines
pnpm check:module-graph && pnpm check:model-registry
pnpm exec tsc --noEmit                                        # backend and contracts
python3 scripts/livespec/check.py
```

The whole capability suite (the six e2e files plus the unit specs) runs once at the end, in batches of fresh processes (L-008).

## Final-checkpoint runtime proofs (done by the checkpoint scripts, not by plan or implement passes: L-019)

Starting `apps/core`, `apps/projector` and `apps/worker` on their own (L-004, L-015, L-018: `FeedModule`, `FeedProjectorsModule` and `FeedWorkerModule` resolve every provider with no missing import of the event definitions, ACL adapters or rate-limit policies) and the empty-stack run (`scripts/qa/fresh-run.sh`, L-012) are checkpoint steps. This plan adds no task for them.

Smoke once the stack is up: sign in as a buyer, `POST /api/follow/shop:<uuid>` of a seeded shop twice (both `204`), `GET /api/follow-status?accountIds=shop:<uuid>` shows `following: true, followerCount: 1`, publish a product of that shop through the catalog API, `GET /api/feed` shows the `new_product` item within seconds; `FLUSHDB` the cache Redis database and read again: same items.

## Ops artifacts (no automated test proves these; rows in `specs/UNVERIFIED.md`, status "not run")

- **SC-001**: `pnpm --dir packages/backend loadtest:feed` (k6 `packages/backend/scripts/load-tests/feed.test.js`; written, never run; needs the payment seed, `AUTHOR_EMAIL`, `AUTHOR_ACCOUNT_ID`, `BOARD_ID`): the `follow` scenario makes the seeded buyers follow the author (30% open their feed), the `fanout` scenario publishes probe posts and polls an active follower's feed; fan-out lag for an author with 10,000 followers (30% active): p99 from `feed.item_published` to visible in an active follower's feed under 5 s (`feed_fanout_lag_seconds`). AS-13 and AS-44 prove the mechanism at small scale, not the time.
- **SC-004**: the same script's `reads` scenario, run once at 1, 2 and 4 core instances: p95 under 300 ms for a populated timeline; and its `rebuild` scenario (`REBUILD_EMAIL` = a user following 500 accounts, cache Redis `FLUSHDB` first): first page under 2 s. AS-32/AS-37 prove correctness and the concurrency bound, not the time.
- SC-002, SC-003, SC-005–SC-010 are proven by the e2e files (AS-24; AS-25/AS-32; AS-19; AS-36/AS-38; AS-03/AS-06; AS-28/AS-33; AS-45/AS-46; AS-42).
- The home-feed page and the follow button have no web owner (`questions.md`); journey J05 is the only UI coverage and is run by the final checkpoint.
