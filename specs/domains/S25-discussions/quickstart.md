# Quickstart: validating S25

Prerequisites: `docker-compose.test.yaml` services running (PostgreSQL, Redis, ScyllaDB, Kafka stand-in); migrations applied with `pnpm --dir packages/backend test:stack:migrate` (includes `cql:migrate`, so `060_discussions_s25.cql` is applied). Run backend commands from `packages/backend`. Contracts: [discussions-api.md](contracts/discussions-api.md), [events.md](contracts/events.md); entities: [data-model.md](data-model.md).

```bash
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/community/domain              # unit specs (pure rules)
/opt/sdd/repo/scripts/sdd/test-spec.sh discussions-posts
/opt/sdd/repo/scripts/sdd/test-spec.sh discussions-comments
/opt/sdd/repo/scripts/sdd/test-spec.sh discussions-votes
/opt/sdd/repo/scripts/sdd/test-spec.sh discussions-ranking
/opt/sdd/repo/scripts/sdd/test-spec.sh discussions-markdown
/opt/sdd/repo/scripts/sdd/test-spec.sh discussions-abuse
/opt/sdd/repo/scripts/sdd/test-spec.sh discussions-resilience
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/domains/community/feed                # feed still green (S26 untouched)
/opt/sdd/repo/scripts/sdd/test-spec.sh libs/composition/bff                       # boards upstream schema swap
pnpm check:boundaries
pnpm --dir packages/backend check:table-ownership --strict    # no community line from S25 (S26's projector lines remain until S26)
pnpm check:module-graph && pnpm check:model-registry
pnpm exec tsc --noEmit                                         # backend and contracts
python3 scripts/livespec/check.py
```

Real-application start (L-004, L-015): start `apps/core` and `apps/worker` once (`pnpm --dir packages/backend start:dev` per app, or the compose stack) and watch for a clean boot: `DiscussionsModule` (providers resolve, no missing import of the event definitions or the identity/catalog exports), `DiscussionsWorkerModule` (schedules upserted, relay job registered). Then smoke:

1. Sign in as a user and as a moderator; pick an `ACTIVE` product `P`.
2. `POST /api/boards/P/posts` with an `Idempotency-Key` twice → the same `postId`; `GET /api/boards/P/posts?sort=new` shows it once.
3. `POST /api/posts/:id/comments` twice (root, then a reply); `GET /api/posts/:id/comments` shows the reply embedded; `PUT /api/votes/:commentId` as another user.
4. Stop Kafka, create a post, restart Kafka: `discussion.post_created` appears on `discussion.events` once the relay runs.
5. `FLUSHDB` on the cache Redis database, read the board again: same order and counts.

Fresh-stack verification (L-012): the whole capability suite is run once on an empty stack via `scripts/qa/fresh-run.sh` after the batch run above.

## Ops artifacts (no automated test proves these; rows in `specs/UNVERIFIED.md`, status "not run")

- **SC-001**: timed browser run of "open product → Discussions → post with a 200-character body → see it on the board" under 5 s (the W02 journey proves the flow, not the time); the double-click half is AS-06.
- **SC-002**: `pnpm --dir packages/backend loadtest:discussions` (k6 `scripts/load-tests/discussions.test.js`, created by this change): 10,000 votes/s over distinct voters; after the run `discussions.reconcile` reports zero drift and the displayed count equals the distinct voters.
- **SC-003**: the same script's read scenario: 50,000 reads/s of board and thread first pages (p99 < 50 ms) and votes (p99 < 30 ms).
- **SC-005**: seed one post with 50,000 comments (script in `scripts/load-tests/seed/`), read the first page and one "load more", check the store's rows read per request; AS-18 proves the bound at partition size 5.
- Rate-limit headers through the real edge and CSRF of cookie-authenticated writes are S50 / S01 / S48 concerns, not re-proven here.
