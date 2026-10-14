# Contract: S47 queues, events and jobs

## Published

None. Model calls are announced as `llm.call_completed` through `CallRecorder` (interim: the existing `LlmCallCompleted` definition with `purpose: 'rag'`, extended with optional `scopeId` and `outcome`; replaced by S46's recorder, research R-2).

## Queue `knowledge-ingest` (consumer: `KnowledgeWorkerModule`)

Body `{documentId: uuid}` (strict). `bodySchema` dead-letters any other body at once (reason `SCHEMA_INVALID`, AS-27). DLQ `knowledge-ingest-dlq`; `maxReceiveCount = 5` in `infra/docker/elasticmq/elasticmq.conf` equals `knowledge_max_receives` (asserted by a test). Unknown or `DELETED` document → ack with no effect. Producers: create / uploaded / retry (after commit), re-index, sweep. At-least-once; the conditional claim makes duplicates harmless.

## Consumed events (consumers: `KnowledgeProjectorModule`)

| Consumer group | Event | Topic | Payload (real schema) | Effect |
|---|---|---|---|---|
| `knowledge-product-deleted` | `catalog.product_deleted` v1 | `products.events` | `{productId, shopId, productVersion}` | documents of `productId` → `DELETED`, passages and bytes removed |
| `knowledge-shop-deleted` | `tenancy.shop_deleted` v1 | tenancy topic | `{shopId, shopVersion}` | every document of `shopId` → `DELETED`, passages and bytes removed; platform and other shops untouched |

Idempotency `natural` (conditional deletes; a repeat finds the work done). Invalid payloads, wrong versions and non-JSON are dead-lettered by the framework and never block the next message (AS-52). Archived / restored / suspended events are not consumed: status is read at ask time.

## Job `knowledge.sweep` (S49)

Payload `{}`; schedule every 5 minutes; steps and idempotency in `research.md` R-7.
