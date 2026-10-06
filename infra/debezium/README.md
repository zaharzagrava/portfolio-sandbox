# Debezium CDC for the outbox (F-05)

Two interchangeable relays move `Outbox` rows to Kafka:

| | Poller (`OutboxPublisherService`, default) | Debezium (this folder) |
|---|---|---|
| How | `UPDATE ... FOR UPDATE SKIP LOCKED` lease claim every 2 s | reads the Postgres WAL via a logical replication slot |
| DB load | one indexed query per poll per instance | none on tables (WAL streaming) |
| Latency | ≤ poll interval | sub-second |
| Ordering | per key within a batch | WAL order (commit order) |
| Ops | nothing extra | Kafka Connect cluster, replication slot monitoring (a stuck slot retains WAL → disk fills) |

The Outbox Event Router SMT routes each row to the topic in its `topic`
column, keyed by `aggregateId`, with the envelope (`payload`) as the value -
the same shape the poller publishes, so consumers don't care which relay ran.

Run (never started automatically):

```bash
docker compose --profile cdc up -d debezium
curl -X PUT -H 'Content-Type: application/json' \
  --data @infra/debezium/outbox-connector.json \
  http://localhost:8083/connectors/marketplace-outbox/config
```

With Debezium on, stop the poller (`OUTBOX_RELAY=cdc`, see `OutboxPublisherService`) and
add a cleanup job that deletes published/streamed rows (the WAL already carried them).
