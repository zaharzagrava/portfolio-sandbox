# F-02 — Local Infra & Storage Drivers

Status: ☑ done (typechecked; nothing started) · Phase 0 · Depends on: — · Used by: SD-03, 10, 13, 15, 23, 25–27, 33, 42–44

## Why
New sections need storage the repo doesn't have yet. Add them to docker-compose (never started by Claude, D2) and wrap each in a Nest dynamic module.

## Additions
| Service | docker-compose | Nest module | Used by |
|---|---|---|---|
| Postgres + **PostGIS + pgvector** | custom image `infra/docker/postgres/Dockerfile` (replaces `postgres:18.3-alpine`) | existing Sequelize | SD-13, SD-43 |
| **MinIO** (S3) | `minio/minio` + bucket init job | extend `aws-api` → `S3StorageService` (presign PUT/POST, multipart, lifecycle) | SD-10, 25, 26, 27, 44 |
| **ElasticMQ** (SQS) | `softwaremill/elasticmq-native` + `elasticmq.conf` (queues + DLQs + redrive) | `SqsModule` (`@aws-sdk/client-sqs`) producer + polling consumer w/ visibility extension | SD-03, 10, 26, 27, 30, 44 |
| **DynamoDB Local** | `amazon/dynamodb-local` | `DynamoModule` (`@aws-sdk/lib-dynamodb`) + table bootstrap script | SD-15, 23, 03 |
| **ScyllaDB** (Cassandra CQL) | `scylladb/scylla` (`--smp 1 --memory 1G`) + CQL migrations in `packages/backend/cql/NNN_*.cql` | `CassandraModule` (`cassandra-driver`, prepared statements, token-aware LB policy, LOCAL_QUORUM) — Amazon Keyspaces in AWS | SD-09, 11, 15, 17, 31 |
| **Mailpit** (SMTP) | `axllent/mailpit` | used by SD-17 email channel (nodemailer) | SD-17 |
| **ClamAV** | `clamav/clamav` | `VirusScanService` (clamd TCP INSTREAM) | SD-27 |
| Observability: OTel Collector, Prometheus, Grafana, Loki | see SD-33 | — | SD-33 |

## Patterns showcased
- Dynamic modules with `forRootAsync` (02/05 §2), lifecycle hooks for connection close (02/05 §3).
- Port/adapter: `ObjectStorage`, `TaskQueue`, `KeyValueTable` interfaces with fake in-memory adapters for unit tests (D9).
- DynamoDB partition-key design (10/01 §3) documented per table.

## Steps
- [x] `infra/docker/postgres/Dockerfile` (postgres 18 + postgis + pgvector), migration enabling extensions (`CREATE EXTENSION IF NOT EXISTS postgis; vector;`).
- [x] docker-compose: minio (+ `mc` init), elasticmq (+ config), dynamodb-local, mailpit, clamav. Ports documented in root README table.
- [x] Config keys in `ApiConfigService` (`s3_endpoint`, `sqs_endpoint`, `dynamo_endpoint`, ...), `.env.example`.
- [x] `libs/common/src/storage/` (S3 port + adapter + fake), `libs/common/src/sqs/`, `libs/common/src/dynamo/`.
- [x] `scripts/cql/migrate.ts` (applies `cql/*.cql` in order, tracks applied files in a `schema_migrations` table).
- [x] `scripts/dynamo/create-tables.ts` reading `dynamodb/*.json`.
- [x] Unit tests for adapters' request building (mock SDK clients with `aws-sdk-client-mock`).

## FE visualisation (phase 2)
—

## Scale
Each store is chosen for an access pattern that Postgres would choke on: DynamoDB for append-heavy per-key time series (partition key + sort key, on-demand capacity), S3 for bytes (never through API servers), SQS for elastic task fan-out with DLQs.

## Implementation notes (2026-10-01)
- `infra/docker/postgres/Dockerfile` (postgres:18 + postgis-3 + pgvector); compose `db` builds it, runs with `wal_level=logical` (F-05 Debezium) and `pg_stat_statements` preloaded.
- Migration `20261001090000-enable-postgis-pgvector.js` (postgis, vector, btree_gist, pg_trgm, pg_stat_statements).
- docker-compose: `minio` (+`minio-init` bucket), `elasticmq` (+ `infra/docker/elasticmq/elasticmq.conf` with all task queues + DLQs), `dynamodb` (host **8100**, Nest API owns 8000), `scylla`, `mailpit`, `clamav`.
- Nest modules (ports + adapters): `storage/` (`ObjectStorage`, `S3ObjectStorage` presigned POST with size/type policy, multipart, streaming put; `InMemoryObjectStorage`), `sqs/` (`TaskQueue`, `SqsTaskQueue` long-poll consumer with concurrency + visibility heartbeat + trace propagation; `InMemoryTaskQueue`), `dynamo/` (`DynamoService`), `cassandra/` (`CassandraService` token-aware, LOCAL_QUORUM, prepared; readiness non-critical).
- Scripts: `pnpm cql:migrate`, `pnpm dynamo:create-tables`; `infra:setup` runs both. `cql/000_keyspace.cql`. Env template `packages/backend/.env.showcase.example`.
- AWS SDK aligned to 3.1143 (client-s3 / lib-storage bumped to match presigners).
