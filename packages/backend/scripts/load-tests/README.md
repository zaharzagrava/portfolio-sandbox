# Load tests

Four end-to-end flows. Each one seeds its own data, then k6 replays it. Every
k6 iteration is one seeded account: it logs in through the real auth endpoint,
then does that flow's work.

| Flow | Seeds | k6 iteration | Main metric |
| --- | --- | --- | --- |
| `payment` | 100k buyers + 1 `BisOrder` each | login → 3× `POST /api/payments` on the **edge** → polls ~10% of them until settled | `payment_settle_time` |
| `search` | 100k buyers, 1k sellers, 50k products (Postgres + Elasticsearch) | login → 5× `GET /api/products/search` (fuzzy, facets, filters, autocomplete prefixes, k-NN) | `http_req_duration{name:GET /api/products/search}` |
| `seller-stats` | 100k buyers, 5k sellers, 50k products, 2.5M sales rows (ClickHouse) | **seller** login → 5× `GET /api/sellers/me/stats?days=7\|30\|90` | `http_req_duration{name:GET /api/sellers/me/stats}` |
| `chat` | 100k buyers, 100 sellers with one channel each | login → `POST /api/chat/ws-ticket` → WebSocket to the Rust gateway → join 3 channels → one message per second for 30s | `chat_message_rtt` |

## Prerequisites

1. Infra is up and migrated: `pnpm docker`, then `pnpm infra:setup` (the new migration adds `User.email/passwordHash/role`).
   - To give the payment consumers more than one partition: `KAFKA_PARTITIONS=6 pnpm kafka:topics:init` (only affects topics that don't exist yet).
2. `creds/jwtRS256.key(.pub)` exist (`node scripts/auth/generate-keys.js`). The edge's `JWT_PUBLIC_KEY` must hold the same public key.
3. In `packages/backend/.env` for load tests:
   - `IS_LOAD_TEST=true`: Stripe is stubbed with a successful response.
   - Set `THROTTLE_API_LIMIT` very high (e.g. `10000000`). The global Nest throttler is per IP, and every k6 VU shares one IP.
4. Services for the flow you're running:
   - all flows: core (`pnpm start:dev`, port from `PORT`, default in these scripts `http://localhost:8000`)
   - `payment`: edge worker (`cd ../edge-be && npx wrangler dev`, `:8787`) + **one** payment processor: NestJS (`pnpm start:dev:payment-processor`) **or** Go (`cd ../payments && go run ./cmd/main.go`)
   - `chat`: Rust gateway (`cd ../hft-platform && cargo run`, `:8090`)
   - `search`: start core at least once before seeding, so it creates the `products` index with its analyzers.
5. [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) installed.

## Running

From `packages/backend`:

```bash
pnpm loadtest:seed payment          # or: search | seller-stats | chat
pnpm loadtest:payment               # PROFILE=smoke by default (5 VUs, 20 iterations)

# Full run: every seeded user, 500 concurrent VUs
k6 run -e PROFILE=load scripts/load-tests/payment.test.js
```

Seeder flags (defaults shown):

```bash
node scripts/load-tests/seed/index.js payment      --users=100000
node scripts/load-tests/seed/index.js search       --users=100000 --sellers=1000 --products=50000
node scripts/load-tests/seed/index.js seller-stats --users=100000 --sellers=5000 --products-per-seller=10 --sales-per-seller=500
node scripts/load-tests/seed/index.js chat         --users=100000 --channels=100
node scripts/load-tests/seed/index.js clean <flow> # remove a flow's data
```

Re-seeding a flow first deletes that flow's previous accounts and everything
hanging off them: payments, ledger entries, products, channels, ES docs and
ClickHouse rows. Accounts are namespaced as `lt-<flow>-<role>-<n>@loadtest.local`,
and all of them share one password (`LOADTEST_PASSWORD`, default
`LoadTest-Passw0rd!`).

**Why seeding is fast but login isn't:** the password is bcrypt-hashed once
and reused for every row, so 100k users seed in seconds. Every login still
runs a full `bcrypt.compare` (cost 10, roughly 50–100 ms of CPU on libuv's 4
threads). Login is therefore the first bottleneck you'll hit. That's real
behaviour, not a test artifact. To take it out of the picture, seed with
`SEED_BCRYPT_ROUNDS=4`, or raise `UV_THREADPOOL_SIZE` for core.

## Knobs (`k6 run -e KEY=value`)

| Key | Default | Applies to |
| --- | --- | --- |
| `PROFILE` | `smoke` | all: `smoke`, `load`, `stress` |
| `VUS`, `ITERATIONS`, `MAX_DURATION` | per profile | all (override the profile) |
| `API_URL` / `EDGE_URL` / `SEARCH_URL` / `CHAT_WS_URL` | `:8000` / `:8787` / `API_URL` / ticket's `wsUrl` | all |
| `PAYMENTS_PER_USER`, `TRACK_RATE`, `SETTLE_TIMEOUT_MS` | `3`, `0.1`, `30000` | payment |
| `SEARCHES_PER_USER` | `5` | search |
| `STATS_CALLS_PER_SELLER` | `5` | seller-stats |
| `SESSION_SECONDS`, `SEND_INTERVAL_MS`, `CHANNELS_PER_USER` | `30`, `1000`, `3` | chat |

Each run writes `load-test-<flow>.html` and `load-test-<flow>.json` to the
current directory.

## NestJS vs Go payment processor

Both consume `payments.requests` with the same consumer group
(`payment-processor`) and write the same rows (Payment, LedgerEntry, Outbox),
so you can swap them without touching anything else. **Run only one at a
time.** Compare `payment_settle_time` and `payments_settle_timeouts` across two
identical runs:

```bash
pnpm loadtest:seed payment
pnpm start:dev:payment-processor &           # run A: NestJS
k6 run -e PROFILE=load scripts/load-tests/payment.test.js
# stop it, then
pnpm loadtest:seed payment
(cd ../payments && CONSUMER_WORKERS=1 go run ./cmd/main.go) &   # run B: Go
k6 run -e PROFILE=load scripts/load-tests/payment.test.js
```

The NestJS consumer handles one message at a time per partition.
`CONSUMER_WORKERS=1` makes the Go consumer do the same, which gives a
like-for-like comparison. Raise it (e.g. `32`) to see what key-sharded
concurrency adds.
