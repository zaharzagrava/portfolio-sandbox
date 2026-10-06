# payments (Go)

A Go port of the NestJS payment processor
(`packages/backend/apps/payment-processor` →
`libs/common/src/payment/payment.service.ts`). It exists so the two
implementations can be load-tested against each other
(`packages/backend/scripts/load-tests`, flow `payment`).

It is a drop-in replacement. It uses the same Kafka topic and consumer group,
the same Postgres tables and the same Outbox contract, so the edge worker, the
outbox mailman, the SSE gateway and the read API can't tell which processor
handled a payment. **Run it or `nest start payment-processor`, not both.**

## Flow (same as `PaymentService#executePayment`)

1. Consume `payments.requests` and continue the edge's trace from the `traceparent` record header.
2. `INSERT … ON CONFLICT ("idempotencyKey") DO NOTHING`, then load the row. This is the idempotency gate.
3. If the row is already settled, return it.
4. Optional stock pre-check (`productId`).
5. Stripe `POST /v1/payment_intents` (`confirm=true`), behind a circuit breaker and with Stripe's own `Idempotency-Key`.
6. One transaction: OCC stock decrement, `PENDING → COMPLETED|FAILED`, double-entry ledger rows, Outbox row for `payments.responses`.
7. If the stock race was lost after the charge, refund and mark `REFUNDED` (the saga's compensation step).

The error boundary (`internal/outbox`) mirrors `OutboxService#wrapInOutbox`:

| Area | What happens |
| --- | --- |
| TRANSIENT | retried with 1s/2s/4s backoff |
| FATAL, or retries exhausted | written to `payments.dlq`, offset committed |
| DOMAIN leaking out of the handler | wrapped as `Fatal_DomainErrorIsThrown` → DLQ |

Responses go to Kafka only through Outbox rows, which the NestJS core app's
mailman publishes.

## Intentional differences from the NestJS version

- **Card declines** (Stripe HTTP 402) become a `FAILED` payment plus a `Domain_StripePaymentFailed` outbox event. The Node SDK throws on declines, so NestJS retries them as transient and eventually DLQs them (see the TODO in `stripe.service.ts`).
- **Ledger invariant violations** are FATAL. NestJS throws an `HttpException` there, which its outbox wrapper classifies as TRANSIENT and retries 3× for nothing.
- **Concurrency:** `CONSUMER_WORKERS` shards each polled batch by idempotency key across goroutines. Per-payment ordering is kept, and offsets are committed after the whole batch. `CONSUMER_WORKERS=1` (the default) matches NestJS's one-message-at-a-time behaviour.

## Running

```bash
cd packages/payments
go mod tidy                 # first time: resolves deps, writes go.sum
go run ./cmd/main.go        # reads ../backend/.env by default
```

Configuration uses the backend's variable names (`NODE_ENV`, `DB_*`,
`KAFKA_BROKER`, `KAFKA_API_KEY/SECRET`, `STRIPE_SECRET_KEY`, `IS_LOAD_TEST`),
plus:

| Var | Default | |
| --- | --- | --- |
| `ENV_FILE` | `../backend/.env` | dotenv file; real env vars take precedence |
| `KAFKA_GROUP_ID` | `payment-processor` | same group as NestJS, so switching resumes from committed offsets |
| `CONSUMER_WORKERS` | `1` | goroutines per polled batch |
| `DB_POOL_MAX` | `20` | pgxpool max connections |
| `DB_SSLMODE` | `disable` (`require` in production) | |
| `PG_SIMPLE_PROTOCOL` | `false` | set `true` when `DB_PORT` is a PgBouncer in transaction mode |
| `OTEL_ENABLED` | `true` | OTLP/HTTP to `OTEL_EXPORTER_OTLP_ENDPOINT` (default `localhost:4318`, i.e. Jaeger) |
| `OTEL_SERVICE_NAME` | `payment-service-go` | shows up in Jaeger next to NestJS's `payment-service` |

## Layout

```
cmd/main.go            wiring + graceful shutdown
internal/config        env loading (same names as packages/backend/.env)
internal/consumer      franz-go consumer group, trace extraction, key-sharded workers
internal/payment       executePayment port + SQL
internal/outbox        Outbox inserts + wrapInOutbox error boundary
internal/ledger        double-entry sale booking
internal/stripe        REST client + gobreaker circuit breaker + load-test stub
internal/apperr        error.types.ts port (DOMAIN / FATAL / TRANSIENT)
internal/tracing       OTel setup + RunInSpan
```
