# Cross-domain journeys

Black-box API e2e tests (`*.journey-spec.ts`) for the `J*` capabilities in `scripts/sdd/capabilities.tsv`.
They exercise the hand-offs between domains (outbox → Kafka → projectors, SQS tasks, scheduled jobs) that a
single-capability e2e spec can't, so they run against the **running local stack**, not a testing module:

```bash
moon run :infra-up && moon run :infra-setup   # stores (docker compose)
moon run :dev-monolith                         # API + workers + projectors in one process, on API_URL
pnpm test:journeys                             # API_URL defaults to http://localhost:8000
```

Rules (constitution VII):
- Drive everything through public APIs; observe through public APIs or SSE.
- Wait on each spec's eventual-consistency contract (poll with a deadline), never on fixed sleeps.
- Create your own users and shops per test (unique emails/slugs), so journeys can share a stack.
