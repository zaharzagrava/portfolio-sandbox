---
id: S47
title: Ask this product and the shop help center (knowledge documents, ingestion, hybrid retrieval, cited answers)
kind: capability
status: draft
depends_on: [S01, S03, S05, S49, S50, S53, S54]
concepts: [problem-json-errors, rate-limit-policy]
models: []
scope:
  - packages/backend/libs/domains/assistant/knowledge.module.ts
  - packages/backend/libs/domains/assistant/knowledge-stores.module.ts
  - packages/backend/libs/domains/assistant/knowledge-rate-limit-policies.ts
  - packages/backend/libs/domains/assistant/api/knowledge*.ts
  - packages/backend/libs/domains/assistant/application/knowledge-search.service.ts
  - packages/backend/libs/domains/assistant/application/document.service.ts
  - packages/backend/libs/domains/assistant/application/ingest.service.ts
  - packages/backend/libs/domains/assistant/application/ask.service.ts
  - packages/backend/libs/domains/assistant/application/reindex.service.ts
  - packages/backend/libs/domains/assistant/application/sweep.service.ts
  - packages/backend/libs/domains/assistant/application/lifecycle.service.ts
  - packages/backend/libs/domains/assistant/domain/chunker.ts
  - packages/backend/libs/domains/assistant/domain/rrf.ts
  - packages/backend/libs/domains/assistant/domain/citations.ts
  - packages/backend/libs/domains/assistant/domain/prompt.ts
  - packages/backend/libs/domains/assistant/domain/scope.ts
  - packages/backend/libs/domains/assistant/domain/document-state.ts
  - packages/backend/libs/domains/assistant/domain/document-cursor.ts
  - packages/backend/libs/domains/assistant/domain/sensitive-data.ts
  - packages/backend/libs/domains/assistant/domain/retrieval-metrics.ts
  - packages/backend/libs/domains/assistant/infra/pg-*.repository.ts
  - packages/backend/libs/domains/assistant/infra/knowledge-*.ts
  - packages/backend/scripts/rag-eval/rag-eval.ts
  - packages/contracts/src/assistant/**
  - packages/web/components/product/ask-product.tsx
---
# S47 - Ask this product and the shop help center
## Purpose
Sellers add markdown or PDF documents to their shop (public, attached to one product, or private) and platform administrators add help-center articles. Documents are parsed, split along their structure, embedded and indexed for meaning and for keywords. Buyers ask a product a question and shop members ask the help center; the answer streams, is grounded only in the retrieved passages, and cites them. Permissions are part of the retrieval query, and nothing relevant means "not found" without a model call.

## Entry points
- `POST /api/shops/:shopId/knowledge/documents`, `GET /api/shops/:shopId/knowledge/documents`, `GET|DELETE /api/shops/:shopId/knowledge/documents/:documentId`, `POST /api/shops/:shopId/knowledge/documents/:documentId/uploaded`, `POST /api/shops/:shopId/knowledge/documents/:documentId/retry`. [code: packages/backend/libs/domains/assistant/api/knowledge-documents.controller.ts#KnowledgeDocumentsController]
- `POST /api/products/:productId/ask` (anonymous allowed) and `POST /api/shops/:shopId/knowledge/ask`, both `text/event-stream`. [code: packages/backend/libs/domains/assistant/api/knowledge-ask.controller.ts#KnowledgeAskController]
- `POST|GET /api/admin/knowledge/documents`, `GET|DELETE /api/admin/knowledge/documents/:documentId`, `POST /api/admin/knowledge/reindex`: administrators only. [code: packages/backend/libs/domains/assistant/api/knowledge-admin.controller.ts#KnowledgeAdminController]
- `KnowledgeSearchService.search(scope, question, {k})`, exported for the evaluation harness. [code: packages/backend/libs/domains/assistant/application/knowledge-search.service.ts#KnowledgeSearchService]
- Queue `knowledge-ingest` (dead-letter queue `knowledge-ingest-dlq`), job `knowledge.sweep`, consumer groups `knowledge-product-deleted` and `knowledge-shop-deleted`. [code: packages/backend/libs/domains/assistant/infra/knowledge-ingest.consumer.ts#KnowledgeIngestConsumer]

## Rules
- **S47.R-01** A document MUST be markdown up to 1 MiB or a PDF up to 20 MiB, a body outside the contract (both forms, neither, unknown field, bad limits) MUST be `400` `validation_failed` before anything is stored or queued, and the exact limits MUST be accepted. [proof: S47 AS-17] [code: packages/contracts/src/assistant/knowledge.ts#knowledgeCreateRequestSchema]
- **S47.R-02** The same bytes in the same scope (shop or platform, product, visibility) MUST be one document: a repeat answers `200` `deduplicated: true`, and five concurrent repeats create one row, one stored object and one task. [proof: S47 AS-21, S47 AS-22] [code: packages/backend/libs/domains/assistant/application/document.service.ts#DocumentService]
- **S47.R-03** A PDF create MUST return an upload grant bound to its hash and size that expires within 15 minutes, and `uploaded` MUST queue the document once. [proof: S47 AS-16] [code: packages/backend/libs/domains/assistant/infra/storage.adapter.ts#StorageAdapter]
- **S47.R-04** `uploaded` before any bytes exist MUST answer `409` `upload_missing`, a repeat on `QUEUED`, `PROCESSING` or `READY` MUST answer `200` with no second task, and a `FAILED` document MUST answer `409` `invalid_transition`. [proof: S47 AS-23] [code: packages/backend/libs/domains/assistant/domain/document-state.ts#canMove]
- **S47.R-05** A product of another shop or an unknown product MUST be the same `404`, an archived product `409` `product_archived`, and a private document attached to a product `422` `product_document_must_be_public`, all without storing anything. [proof: S47 AS-17, S47 AS-20]
- **S47.R-06** Document responses MUST be the explicit contract shape: no storage location, content hash, indexed hash, embedding model, creator or raw error text. [proof: S47 AS-15] [code: packages/backend/libs/domains/assistant/application/document-dto.ts#toDocumentDto]
- **S47.R-07** The list MUST be keyset-paged newest first with an opaque signed cursor, a `status` filter and `limit` 1 to 100, and a malformed, tampered or foreign cursor MUST answer `400` `invalid_cursor`. [proof: S47 AS-31] [code: packages/backend/libs/domains/assistant/domain/document-cursor.ts#decodeDocumentCursor]
- **S47.R-08** Every document route MUST answer `401` without valid credentials, `404` to a non-member, `403` to a member without the permission, `403` `shop_suspended` or `409` `shop_offboarding` on writes of a closed shop (reads stay open), and `403` to a non-administrator on admin routes. [proof: S47 AS-18, S47 AS-19]
- **S47.R-09** A shop MUST hold at most 1,000 non-deleted documents (`422` `document_limit_reached`, a duplicate still `200`), and creating or confirming an upload MUST be limited to 30 a minute per shop (`429` `rate_limited`), where an invalid request does not use the allowance. [proof: S47 AS-32, S47 AS-33] [code: packages/backend/libs/domains/assistant/knowledge-rate-limit-policies.ts#knowledgeRatePolicies]
- **S47.R-10** Delete MUST make the document unsearchable in the response, remove its stored bytes, answer `404` to a repeat and `204` to exactly one of two concurrent calls; retry MUST be possible only from `FAILED` (`202`, otherwise `409`). [proof: S47 AS-28, S47 AS-30] [code: packages/backend/libs/domains/assistant/infra/pg-document.repository.ts#PgDocumentRepository]
- **S47.R-11** Ingestion MUST claim a document with a lease so that a redelivery is a no-op, two workers at once embed once, a live lease elsewhere is left alone and an expired one is taken over. [proof: S47 AS-26] [code: packages/backend/libs/domains/assistant/application/ingest.service.ts#IngestService]
- **S47.R-12** Markdown and PDF MUST become passages with heading paths, page numbers, an embedding, a keyword entry and 1 to 800 tokens, with the embedding model recorded on the document and on every passage. [proof: S47 AS-15, S47 AS-16]
- **S47.R-13** A deterministic problem (not a PDF, unparseable, no text, too many pages or passages, size or hash mismatch) MUST end `FAILED` once with a stable `failureCode`, be acknowledged, store no passage and never show parser text. [proof: S47 AS-24] [code: packages/backend/libs/domains/assistant/domain/failure-codes.ts#IngestFailure]
- **S47.R-14** A transient problem MUST return the document to `QUEUED` and rethrow for redelivery, the fifth receive MUST end `FAILED` `embedding_unavailable` keeping the previous passages searchable, and the queue's redelivery limit MUST equal the configured one. [proof: S47 AS-25]
- **S47.R-15** A queue body that is not `{documentId: uuid}` MUST be dead-lettered with no effect and a task for an unknown or deleted document MUST be acknowledged with no effect. [proof: S47 AS-27] [code: packages/backend/libs/domains/assistant/infra/knowledge-ingest.consumer.ts#ingestBodySchema]
- **S47.R-16** A delete that races an ingestion pass MUST win: the document stays `DELETED` with no passage. [proof: S47 AS-29]
- **S47.R-17** Chunking MUST keep heading paths, treat `#` lines inside fences as text, never cross a PDF page, merge tiny sibling sections only under one parent, overlap long sections by about 80 tokens, never exceed 800 tokens, number passages without gaps and keep every sentence. [proof: S47 AS-34] [code: packages/backend/libs/domains/assistant/domain/chunker.ts#chunkSections]
- **S47.R-18** Reciprocal rank fusion MUST add `1 / (60 + rank)` per list, count a repeat inside a list once at its best rank, keep first-seen order on ties and order by descending score. [proof: S47 AS-44] [code: packages/backend/libs/domains/assistant/domain/rrf.ts#reciprocalRankFusion]
- **S47.R-19** Retrieval MUST find a paraphrase by meaning, a model number or a heading word by keywords alone, and drop a meaning hit below the relevance floor unless the keyword search also found it. [proof: S47 AS-43, S47 AS-45] [code: packages/backend/libs/domains/assistant/application/knowledge-search.service.ts#KnowledgeSearchService]
- **S47.R-20** Visibility, shop, product and document status MUST be part of the query that ranks passages and repeated when their text is loaded, so a buyer sees only the product's and the shop's public passages and a member only platform plus the shop's own, however many foreign passages rank higher. [proof: S47 AS-35, S47 AS-36, S47 AS-37, S47 AS-38] [code: packages/backend/libs/domains/assistant/infra/pg-passage.repository.ts#PgPassageRepository]
- **S47.R-21** If the question cannot be embedded in time retrieval MUST fall back to keywords (`mode: "keyword"`), count it and not retry within the request, and an embedding MUST be cached by model and normalized question for 24 hours with the cache optional. [proof: S47 AS-46, S47 AS-47]
- **S47.R-22** A retrieval that exceeds its deadline MUST answer `503` `assistant_unavailable` with `Retry-After` before any stream, with a generic body. [proof: S47 AS-48]
- **S47.R-23** The checks of an ask MUST run in this order and stop at the first failure: credentials (`401`), request validation (`400`), rate limit (`429`, `503` `rate_limiter_unavailable`), product and shop lookup (`404`), input moderation (`422`, `503`), provider budget (`429` `assistant_busy`), retrieval (`503`). [proof: S47 AS-05, S47 AS-07, S47 AS-08, S47 AS-14] [code: packages/backend/libs/domains/assistant/application/ask.service.ts#AskService]
- **S47.R-24** An unknown, archived or inactive-shop product MUST answer the same `404` and serve again once restored, a flagged or sensitive question MUST be `422` `input_rejected` with its category and no question text, and a failing moderation backend MUST be `503`. [proof: S47 AS-04, S47 AS-06]
- **S47.R-25** An anonymous buyer MUST be served and recorded as `anonymous`, while an invalid or expired token MUST be `401`. [proof: S47 AS-02] [code: packages/backend/libs/domains/assistant/api/knowledge-auth.ts#AnonymousOrAuthenticated]
- **S47.R-26** An answer MUST stream `sources` then `text` then `done`, with the model request made of one fixed instruction block, one citable block per passage and the question last, and no cost or model name in any event. [proof: S47 AS-01] [code: packages/backend/libs/domains/assistant/domain/prompt.ts#buildAnswerRequest]
- **S47.R-27** Nothing retrieved MUST answer `not_found` with no model call and no usage record. [proof: S47 AS-03]
- **S47.R-28** The instruction block MUST be a constant that no document or question changes. [proof: S47 AS-13] [code: packages/backend/libs/domains/assistant/domain/prompt.ts#RAG_INSTRUCTIONS]
- **S47.R-29** Citations MUST be the provider's structured data validated against the retrieved set, deduplicated, and reported with `grounded` true only when one block carries a valid index. [proof: S47 AS-12] [code: packages/backend/libs/domains/assistant/domain/citations.ts#citationsOf]
- **S47.R-30** A provider failure, a missed first-token or whole-answer deadline, a refusal or a client disconnect MUST end the stream with `error`, `refusal` or silence, abort the provider call, and be recorded once as failed, refused or aborted with an estimated count. [proof: S47 AS-09, S47 AS-10, S47 AS-11]
- **S47.R-31** The answer MUST be moderated per chunk with the preceding text, and a flagged chunk MUST NOT be published and ends the stream with a moderation refusal. [proof: S47 AS-10]
- **S47.R-32** A shop member MUST be able to ask the help center and get platform articles and the shop's own documents, recorded under the user id and the shop id, also from a suspended shop. [proof: S47 AS-39]
- **S47.R-33** An administrator MUST be able to create, list and delete platform articles that no shop route can touch, that every shop's help center can cite and that no buyer sees. [proof: S47 AS-40]
- **S47.R-34** Passages of another embedding model MUST leave the meaning search but stay findable by keywords, re-index MUST enqueue each stale `READY` document once, and the swap MUST show a concurrent question all old or all new passages of a document. [proof: S47 AS-41] [code: packages/backend/libs/domains/assistant/application/reindex.service.ts#ReindexService]
- **S47.R-35** The sweep MUST delete uploads abandoned for 24 hours, enqueue documents stuck `QUEUED` for 5 minutes once, release expired leases, retry orphaned bytes and purge tombstones after 30 days, and a second or concurrent run MUST change nothing. [proof: S47 AS-42] [code: packages/backend/libs/domains/assistant/application/sweep.service.ts#SweepService]
- **S47.R-36** A deleted product or shop MUST delete its documents, passages and bytes once, leave other documents untouched, and dead-letter an invalid event without blocking the next one. [proof: S47 AS-50, S47 AS-51, S47 AS-52] [code: packages/backend/libs/domains/assistant/application/lifecycle.service.ts#LifecycleService]
- **S47.R-37** The evaluation harness MUST report recall at k and mean reciprocal rank without a model call, exit `1` below the minimum recall and `2` on a malformed golden file naming the case. [proof: S47 AS-49] [code: packages/backend/scripts/rag-eval/rag-eval.ts#runEval]
- **S47.R-38** The metrics `rag_ingest_total`, `rag_retrieval_duration_seconds`, `rag_retrieval_degraded_total`, `rag_answers_total` and `rag_documents` MUST move, and no log line, metric label or span attribute may hold a question, a document text or title, a presigned address or a secret. [proof: S47 AS-53] [code: packages/backend/libs/domains/assistant/domain/knowledge-metrics.ts#ragAnswers]
- **S47.R-39** Production MUST refuse to start with the deterministic test embedder, the scripted model provider, an embedding dimension other than 1,024, or no moderation backend, naming the key and never a value. [proof: S47 AS-54] [code: packages/backend/libs/domains/assistant/infra/knowledge-config.guard.ts#KnowledgeConfigGuard]
- **S47.R-40** Neither table MUST have a foreign key to another domain's table, and both MUST be registered under the assistant domain. [proof: S47 AS-55]
- **S47.R-41** The web question box MUST show the sources as chips, flag an answer that cited nothing, show a refusal as a refusal and give each refused request a message of its own. [proof: S47 AS-01, S47 AS-10, S47 AS-12]

## Behaviors
- **S47.B-01** Given a manual that says the phone supports eSIM, when a buyer asks whether it does, then the answer streams with the manual's section as its source. [proof: S47 AS-01]
- **S47.B-02** Given a question the documents do not answer, when a buyer asks, then they are told so and the model is not called. [proof: S47 AS-03]
- **S47.B-03** Given a private contract of one shop, when another shop's member asks about it, then nothing of it reaches the answer or the model. [proof: S47 AS-38]
- **S47.B-04** Given the embedding provider down, when a buyer asks a question whose words are in a document, then the answer comes from keywords alone. [proof: S47 AS-46]
- **S47.B-05** Given a PDF that is not a PDF, when it is ingested, then the document fails once with a code the seller can act on. [proof: S47 AS-24]
- **S47.B-06** Given a document deleted while its embeddings are computed, when the pass ends, then it stays deleted with no passage. [proof: S47 AS-29]
- **S47.B-07** Given a product that is deleted, when the event is delivered twice, then its documents are deleted once. [proof: S47 AS-50]

## Lifecycles
A document is awaiting upload, queued, processing, then ready or failed; failed and ready documents can be queued again (retry, re-index); any state can end deleted, which is final (a tombstone stays 30 days).

## Owns
- PostgreSQL tables `KnowledgeDocument` and `KnowledgeChunk`.
- Object storage prefix `knowledge/`, Redis keys `rag:qe:v1:*` (every key expires), queue `knowledge-ingest` with its dead-letter queue.
- Job `knowledge.sweep`, rate-limit policies `rag.ask` and `rag.ingest`, metrics `rag_*`.

## Decisions
- Raw SQL inside repositories behind domain ports; no model, no foreign key to another domain, deletion by events instead of a cascade.
- A passage serves while its document is not deleted and holds passages, so a document being re-indexed keeps answering.
- Ranking and text loading share one repeatable-read snapshot, so a swap is seen whole.
- The interim adapters for the model, the call recorder and the moderator are replaced by S46's exports one file each.

## Known gaps
- The throughput, latency and real-provider success criteria (SC-002, SC-003, SC-004's 60 seconds, SC-006) have no automated proof (listed in `specs/UNVERIFIED.md`).
- The seller's document screens and the help-center box belong to W04; the two journeys that need them are skipped until it names this capability.
- The debt row for the model provider and usage coupling (D-14) closes only when S46 lands.
