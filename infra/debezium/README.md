# Debezium CDC for the outbox (F-05, S53)

Two interchangeable relays move `Outbox` **event** rows to the log:

| | Poller (`OutboxPublisherService`, default) | Debezium (this folder) |
|---|---|---|
| How | claim with a lease (`FOR UPDATE SKIP LOCKED`) every 2 s, send, mark published | reads the Postgres WAL via a logical replication slot |
| DB load | one indexed query per poll per instance | none on tables (WAL streaming) |
| Latency | ≤ poll interval | sub-second |
| Ordering | per aggregate, a failing row holds its aggregate back | WAL order (commit order) |
| Ops | nothing extra | Kafka Connect cluster, replication slot monitoring (a stuck slot retains WAL → disk fills) |

Both produce **the same message** (S53 FR-013, spec AS-13 and AS-21):

- topic: the row's `topic` column (`<aggregateType>.events`);
- key: `aggregateId`;
- value: the event envelope itself (the `payload` column expanded, no `{payload, extra, error}` wrapper);
- headers: `eventId`, `type`, `version`, and `traceparent` when the envelope has one.

The connector (`outbox-connector.json`) therefore: includes only `public.Outbox`; drops everything but inserted
`kind = 'event'` rows (task rows go to a queue, not the log); routes with the Outbox Event Router by `topic`,
keyed by `aggregateId`; copies the envelope fields into the headers with `HeaderFrom`. `outbox-isolation` and
`connector-config.spec.ts` pin this.

**Tasks.** `OutboxService.appendTask` rows are relayed to their queue by the poller only. A deployment with
`OUTBOX_RELAY=cdc` must therefore not use `appendTask` (the connector filters task rows out, they would otherwise land
on a Kafka topic named like the queue).

## Image

The `kind` filter is a content-based SMT and needs the Debezium scripting plugin (Groovy), which the stock Connect image
does not carry. Build the image from this folder:

```bash
docker build -t marketplace/debezium-connect:3.0 infra/debezium
```

## Run

Never started automatically. Dev stack:

```bash
docker compose --profile cdc up -d debezium
curl -X PUT -H 'Content-Type: application/json' \
  --data @infra/debezium/outbox-connector.json \
  http://localhost:8083/connectors/marketplace-outbox/config
```

Test stack (opt-in, used by `outbox-cdc.e2e-spec.ts`; Connect REST on `localhost:8183`, hostname `test_db`):

```bash
docker compose -f docker-compose.test.yaml -p marketplace_test --profile cdc up -d --build
curl -X PUT -H 'Content-Type: application/json' \
  --data @infra/debezium/outbox-connector.json \
  http://localhost:8183/connectors/marketplace-outbox/config
S53_CDC=1 pnpm --dir packages/backend test:e2e libs/infrastructure/outbox/outbox-cdc
```

The connector reads `DB_HOSTNAME`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` from the Connect container environment.

## Retention

With Debezium on, set `OUTBOX_RELAY=cdc` (the poller does not start, see `OutboxPublisherService`). Published rows are
removed by the `outbox.purge-published` job (S49, 7 days, batches of 1,000) in both modes: the connector never
deletes rows, and the WAL already carried them.
