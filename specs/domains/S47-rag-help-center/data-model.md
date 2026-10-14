# Data model: S47 RAG help center

Owner of every store below: domain `assistant` (knowledge half), already registered in `packages/backend/libs/common/db/ownership.ts` (`KnowledgeDocument`, `KnowledgeChunk`). No other capability reads or writes them (AS-55). No foreign key leaves the domain after the contract migration (research R-5). The domain declares **no Sequelize model**: access is raw SQL inside `infra/pg-*.repository.ts` (D-9 untouched).

## `KnowledgeDocument`

| Column | Type | Rules |
|---|---|---|
| `id` | UUID PK | `uuidv7()` |
| `shopId` | UUID NULL | plain column, no FK; NULL iff `visibility = 'PLATFORM'` (existing CHECK) |
| `productId` | UUID NULL | plain column, no FK; only with `visibility = 'PUBLIC'` (service rule, `422 product_document_must_be_public`) |
| `visibility` | TEXT | `PUBLIC` \| `SHOP_PRIVATE` \| `PLATFORM` |
| `title` | TEXT ≤ 200 | emptied (`''`) on delete (a tombstone holds no text) |
| `format` | TEXT | `MARKDOWN` \| `PDF` |
| `storageKey` | TEXT | internal, never in a DTO; kept on the tombstone until `bytesRemovedAt` is set |
| `contentHash` | CHAR(64) NULL | identity within a scope; unique partial index `KnowledgeDocument_scope_hash` (`status <> 'DELETED'`) exists |
| `contentSize` | BIGINT NULL | **new**; markdown: byte length; PDF: declared `pdfSize` (checked at ingestion, `size_mismatch`) |
| `status` | TEXT | `AWAITING_UPLOAD` \| `QUEUED` \| `PROCESSING` \| `READY` \| `FAILED` \| `DELETED` (set unchanged) |
| `failureCode` | TEXT NULL | **new**; `not_a_pdf` `unparseable` `no_text` `too_many_pages` `too_many_chunks` `size_mismatch` `embedding_unavailable`; set only with `FAILED`, cleared on `QUEUED`/`READY` |
| `error` | TEXT NULL | legacy free text; no longer written after expand, dropped at contract; never read by the API |
| `chunkCount` | INTEGER | serving passages of this document; `> 0` ⇔ the document answers questions (R-4) |
| `indexedHash`, `embeddingModel` | CHAR(64), TEXT NULL | hash and model of the passages currently serving |
| `leaseToken` | UUID NULL | **new**; set by the claim, checked by commit / fail / release |
| `leaseUntil` | TIMESTAMPTZ NULL | **new**; database clock `now() + knowledge_processing_lease_ms` |
| `queuedAt` | TIMESTAMPTZ NULL | **new**; set on every move to `QUEUED`; sweep (b) re-enqueues when older than 5 min |
| `deletedAt` | TIMESTAMPTZ NULL | **new**; tombstone age for the 30-day purge |
| `bytesRemovedAt` | TIMESTAMPTZ NULL | **new**; NULL on a `DELETED` row that has a `storageKey` means object removal is pending (sweep (d)) |
| `createdBy` | UUID NULL | internal; never in a DTO |
| `createdAt`, `updatedAt` | TIMESTAMPTZ | `updatedAt` set by the repository on each move |

**State machine** (`domain/document-state.ts`):

```text
AWAITING_UPLOAD --uploaded--> QUEUED --claim--> PROCESSING --commit--> READY
                                  ^                |  \--deterministic--> FAILED(code)
                                  |                \--transient--------> QUEUED
FAILED --retry--> QUEUED          READY --reindex--> QUEUED
any non-DELETED --delete--> DELETED   (final; tombstone for 30 days)
```

Every arrow is `UPDATE … WHERE status = <from> [AND leaseToken = :t]`. Replays the spec makes idempotent (`uploaded` on `QUEUED|PROCESSING|READY`) read and answer `200` without a second task.

**Indexes** (existing kept): unique `KnowledgeDocument_scope_hash`; new `(shopId, createdAt DESC, id DESC) WHERE status <> 'DELETED'` for the list; new `(createdAt DESC, id DESC) WHERE "shopId" IS NULL AND status <> 'DELETED'` for platform lists; new `(status, queuedAt) WHERE status IN ('QUEUED','PROCESSING','AWAITING_UPLOAD')` and `(deletedAt) WHERE status = 'DELETED'` for the sweeps.

## `KnowledgeChunk` (a "passage")

Existing columns unchanged: `id`, `documentId` (FK to `KnowledgeDocument`, ON DELETE CASCADE, intra-owner, kept), `shopId`, `productId`, `visibility` (copy of the document's scope so permissions filter in the same query), `ordinal`, `headingPath`, `page`, `content`, `tokens` (1–800; CHECK added at expand), `embedding halfvec(1024)`, generated `tsv` (heading weight A, body weight B), `UNIQUE (documentId, ordinal)`.

New: `embeddingModel TEXT` (NULL at expand, backfilled, `NOT NULL` at contract). The vector candidate query filters `= :model` without a join.

Invariants: the passages of one document are replaced in one transaction together with the `READY` update (readers see all old or all new); a passage never outlives its document being `DELETED`.

## Retrieval scope (pure, `domain/scope.ts`)

| Scope | Predicate on passages |
|---|---|
| `product(productId, shopId)` | `visibility = 'PUBLIC' AND shopId = :shop AND (productId = :product OR productId IS NULL)` |
| `shop(shopId)` | `visibility = 'PLATFORM' OR (shopId = :shop AND visibility IN ('PUBLIC','SHOP_PRIVATE'))` |

Both are combined with `d.status <> 'DELETED' AND d."chunkCount" > 0` (and `c."embeddingModel" = :model` for the meaning list) in the ranking query, and again when passage text is loaded.

## Derived and transient stores

| Store | Key | Rules |
|---|---|---|
| Redis | `rag:qe:v1:<sha256(model + normalized question)>` | value: 1,024 floats (JSON); TTL 24 h; optional, errors swallowed and counted |
| SQS | `knowledge-ingest` (+ `knowledge-ingest-dlq`, `maxReceiveCount = 5`) | body `{documentId: uuid}`; duplicates harmless (the claim is conditional) |
| Object storage | `knowledge/<shopId or platform>/<documentId>` | bytes of the document; removed after delete; orphans swept |
| Scheduler | job type `knowledge.sweep` (S49) | payload `{}` |

## Not persisted

Answer stream events (`contracts/knowledge-api.md`); golden cases (`scripts/rag-eval/golden.json`, input of the harness).
