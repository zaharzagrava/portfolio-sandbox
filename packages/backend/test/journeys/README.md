# Cross-domain journeys

Black-box API e2e tests (`*.journey-spec.ts`) for the `J*` capabilities in `scripts/sdd/capabilities.tsv`.
They exercise the hand-offs between domains (outbox → Kafka → projectors, SQS tasks, scheduled jobs) that a
single-capability e2e spec can't, so they run against the **running local stack**, not a testing module:

```bash
moon run infra-setup   # stores (docker compose), then schemas and topics
moon run dev-monolith                         # API + workers + projectors in one process, on API_URL
pnpm test:journeys                             # API_URL defaults to http://localhost:8000
```

Rules (constitution VII):
- Drive everything through public APIs; observe through public APIs or SSE.
- Wait on each spec's eventual-consistency contract (poll with a deadline), never on fixed sleeps.
- Create your own users and shops per test (unique emails/slugs), so journeys can share a stack.

## Environment of the journeys (J01)

| Variable | Meaning |
|---|---|
| `API_URL` | Base URL of the running API, default `http://localhost:8000`. |
| `JOURNEY_ENV` | Path of the env file of the stack; the suite reads `STRIPE_WEBHOOK_SECRET` from it to sign webhook posts (the secret never appears in test output). |
| `JOURNEY_TIME_FACTOR` | Multiplier of every hop deadline (default `1`; raise it on a loaded machine). Deadline = 2 x contract maximum x factor. |
| `CLOCK_CONTROL=enabled` | Stack flag: exposes `GET/PUT /api/admin/clock` (refused at startup when `NODE_ENV=production`). |
| `PROVIDER_DOUBLES=enabled` | Stack flag: payment methods `pm_test_*` and payout accounts `acct_test_*` behave as scripted (refused in production). |

Support kit in `support/`: `journey-client.ts` (cookie jar per actor, contract-parsed responses), `wait-for-contract.ts` (hop table H1..H13),
`control-surface.ts` (jobs, consumers, clock; `restoreAll()` is idempotent) and `seller-fixture.ts`.
Every journey that pauses a consumer or moves the clock restores them in `afterAll`.
