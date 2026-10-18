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

## J02: seller to first sale (`seller-to-first-sale.journey-spec.ts`)

Run one story with `pnpm test:journeys -- -t "US3"`. Scenario titles keep the stable `J02 AS-nn` prefix (L-017).
Hop rows are `J02.H1`..`J02.H17` in `wait-for-contract.ts` (the deadline is twice the contract maximum; `J02.H14` therefore
polls the shop rank for 10 s, the floor S40 allows).

Extra stack settings (all local profile, refused at startup when `NODE_ENV=production`):

| Variable / setting | Meaning |
|---|---|
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | Provisions the platform `ADMIN` the journey signs in as; pass the same pair as `JOURNEY_ADMIN_EMAIL` / `JOURNEY_ADMIN_PASSWORD`. |
| `PROVIDER_DOUBLES=enabled` | Also selects the model double of document extraction (it answers with the `%SCRIPTED-REPLY:` line a `kyc-*.pdf` carries). |
| `ALLOWED_RECEIVER_HOSTS`, `ALLOWED_RECEIVER_CA_FINGERPRINT` | Let the journey's HTTPS receiver be registered and called: `host:port` list, plus the SHA-256 of its self-signed certificate. The receiver prints both at start (`WebhookReceiver.host`, `.caFingerprint`). |
| `SEARCH_REFRESH_INTERVAL=1s` | Makes the search hops reachable (`J02.H9`..`J02.H11`). |
| rate-limit allow-list | The journey's address is allowed to register many accounts (`RATE_LIMIT_ALLOW_LIST`). |

Kit additions: `webhook-receiver.ts` (HTTPS receiver, S43 reference verifier, scripted answers `200 | 500 | hang`),
`kyc-fixtures.ts` with `fixtures/kyc-*.pdf` (five documents, recorded `sha256`; `kycVariant` makes a copy unique to one shop),
and in `seller-fixture.ts` `registerSeller`, `openShop`, `onboardVerified`, `subscribe`, `createProduct`, `createEndpoint`.

Scenario **AS-33** (no raw cross-domain models or SQL on the journey's paths; `check:table-ownership --strict`, `check:boundaries`)
is proved by the static gates, not by an HTTP test; it has no test in the journey file.
