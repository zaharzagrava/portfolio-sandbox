# AI Application Designs

Designs 42–44 of the practice catalog (`03-practice-catalog.md`). From a web engineer's point of view, LLM features are **slow, expensive, rate-limited, non-deterministic external APIs**. Most of the design is about streaming, queues, caching, validation, permissions, and cost control.

---

## 42. LLM chat app (ChatGPT-style)

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AssistantService`](../../packages/backend/libs/domains/assistant/application/assistant.service.ts#L57): AssistantService manages conversation turns, LLM calls, tool execution, history compaction and quota enforcement for the chat feature. _(assistant.service.ts)_
> - [`AssistantController`](../../packages/backend/libs/domains/assistant/api/assistant.controller.ts#L33): AssistantController exposes the conversation, streaming, history, quota and message-cancellation endpoints. _(assistant.controller.ts)_
> - [`useAssistantChat`](../../packages/web/hooks/use-assistant-chat.ts#L19): The useAssistantChat hook manages conversation state, streaming, and sending and cancelling messages on the client. _(use-assistant-chat.ts)_
<!-- theory-links:end -->

### Clarify
- Which model provider(s)? Conversation history, file attachments, tools/function calling? Multi-tenant with per-plan limits?
- Scale: 1M DAU, 20 messages/user/day; responses take 5–60 s to generate.

### Design
```
Browser ─► POST /conversations/:id/messages (fetch + streamed response, or SSE)
   ─► Chat API (Node): auth, rate limit/quota check, load recent history (+ summary of older messages)
   ─► LLM provider (streaming) ─► tokens streamed to the browser as they arrive
   ─► on completion: persist assistant message + token usage (DB), update usage counters
conversations, messages (Postgres; message content can be large → TOAST or S3 for attachments)
```
### Deep dives
- **Streaming**: forward provider tokens as they arrive (`text/event-stream` or a chunked `fetch` body). It's a POST, so the browser reads it with `fetch` + `ReadableStream` (or `@microsoft/fetch-event-source`) rather than `EventSource`. Disable proxy buffering; heartbeats for long pauses; handle client disconnect → abort the provider call (`AbortController`) to stop paying for tokens nobody reads.
- **Long-lived requests**: a Node instance holds many concurrent streams (I/O-bound, fine), but load balancers' idle timeouts and serverless limits (API Gateway 29 s) matter. Use a container platform or a streaming-capable runtime. For very long tasks (agents), switch to a job + progress events (design 27 pattern).
- **Resumability**: if the user refreshes mid-answer, either restart the generation or keep generating server-side into a buffer (Redis stream keyed by message ID) that a reconnecting client can resume from.
- **Context management**: model context windows are limited and tokens cost money. Send recent messages + a rolling summary of older ones; count tokens before sending; system prompt + tool definitions benefit from **prompt caching** (supported by major providers).
- **Rate limits and cost**: provider limits (requests/min, tokens/min) → a shared token-bucket per provider key and per tenant; per-user quotas by plan; model routing (cheap model for simple tasks, expensive model for complex ones); usage metering for billing.
- **Reliability**: provider timeouts and 429/529 errors → retries with backoff, fallback model/provider, circuit breaker.
- **Safety**: input/output moderation, prompt-injection awareness when tools or retrieved content are involved, never put secrets in prompts, PII handling and data-retention settings with the provider.
- **Observability**: latency to first token, total latency, tokens in/out per request, cost per tenant, error rates by provider; store prompts/responses for debugging only within privacy policy.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`useAssistantChat`](../../packages/web/hooks/use-assistant-chat.ts#L19): useAssistantChat handles streamed messages and cancellation on the client side. _(use-assistant-chat.ts)_
> - [`quotaTokens`](../../packages/backend/libs/domains/assistant/infra/llm/pricing.ts#L19): quotaTokens charges tokens against the monthly allowance, with cache reads at 1/10 rate, to control cost. _(pricing.ts)_
> - [`LlmCallCompleted`](../../packages/backend/libs/domains/assistant/application/events/assistant-events.ts#L5): The LlmCallCompleted event records LLM call latency, tokens and cost metrics. _(assistant-events.ts)_
<!-- theory-links:end -->

### Theory
`04-API-Design/01` §2.8 (SSE, streaming responses), `06-Distributed-Systems/03` (timeouts, retries, circuit breakers), `04-API-Design/03` (consuming rate-limited APIs), `02-Node.js/02` (streams).

---

## 43. RAG knowledge base / "chat with your docs"

### Clarify
- Sources (uploaded PDFs, Confluence/Notion/Google Drive sync, DB records)? Volume (100k documents?) and update frequency? **Permissions**: may every user see every document? Citations required?

### Design
```
INGESTION (async)
sources ─► connectors / uploads ─► queue ─► parse (PDF/HTML → text) ─► chunk (≈300–800 tokens, overlap, keep headings)
   ─► embed chunks (embedding model, batched) ─► vector store (pgvector / OpenSearch / dedicated vector DB)
      rows: chunk_id, doc_id, tenant_id, acl/group ids, text, embedding, metadata (title, url, updated_at)

QUERY
question ─► (rewrite query with chat history) ─► embed ─► vector search (top-k) + keyword search (BM25) ─► merge (hybrid)
   ─► filter by tenant + user permissions ─► rerank (cross-encoder / reranker) ─► top 5–10 chunks
   ─► prompt: instructions + chunks (with source IDs) + question ─► LLM (streamed) ─► answer with citations
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`AnswerService`](../../packages/backend/libs/domains/assistant/application/answer.service.ts#L49): AnswerService streams RAG answers using retrieval and rate limiting. _(answer.service.ts)_
> - [`Retriever`](../../packages/backend/libs/domains/assistant/infra/retriever.ts#L62): Retriever does hybrid vector and full-text retrieval with scope-based access control and caching. _(retriever.ts)_
> - [`KnowledgeController`](../../packages/backend/libs/domains/assistant/api/knowledge.controller.ts#L33): KnowledgeController handles document CRUD and streams RAG query answers. _(knowledge.controller.ts)_
<!-- theory-links:end -->
### Deep dives
- **Chunking** quality drives answer quality: split by structure (headings, paragraphs), keep titles/section paths in each chunk, small overlap.
- **Hybrid search**: vector similarity finds semantic matches; keyword (BM25) catches exact terms (error codes, product names). Combine (e.g., reciprocal rank fusion) and rerank.
- **Permissions are non-negotiable**: filter by tenant and the user's document ACLs **inside the vector query** (metadata filters / Postgres `WHERE` with pgvector), never only after generating. Otherwise the LLM can leak content from documents the user can't open.
- **Freshness**: re-ingest on change events (webhooks/CDC from sources), delete chunks of deleted documents, store a content hash to skip unchanged documents.
- **pgvector** (`vector` column + HNSW index) keeps vectors next to relational data and permissions: simple, transactional, fine for millions of chunks. A dedicated vector DB is worth it at very large scale or for advanced features.
- **Hallucination control**: answer only from the provided context, cite sources, say "not found" when retrieval returns nothing relevant (similarity threshold).
- **Evaluation**: a golden set of questions with expected sources; measure retrieval recall and answer correctness when changing chunking, models, or prompts.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`markdownSections`](../../packages/backend/libs/domains/assistant/domain/chunker.ts#L46): markdownSections splits markdown by heading structure and skips code fences. _(chunker.ts)_
> - [`chunkText`](../../packages/backend/libs/domains/assistant/domain/chunker.ts#L197): chunkText prefixes each chunk with its heading path so the embedding keeps context. _(chunker.ts)_
> - [`Retriever`](../../packages/backend/libs/domains/assistant/infra/retriever.ts#L62): Retriever combines vector similarity with full-text search and filters by access scope. _(retriever.ts)_
<!-- theory-links:end -->

### Theory
`03-Databases/01` (indexes, GIN/GiST concepts → HNSW for vectors), `05-Security/02` §7 (record-level permissions), design 36 (connectors), design 27 (document ingestion).

---

## 44. AI document-processing pipeline

**Prompt variants:** "Parse incoming invoices/contracts/forms with an LLM and push structured data into our system", "Turn inbound emails into records in our system".

### Design
```
Email/upload/API ─► store raw document (S3) + record (RECEIVED) ─► SQS
   ─► extract text (PDF/OCR) ─► LLM extraction with a JSON schema (structured output / tool call)
   ─► validate with zod (types, required fields, business rules) ─► confidence/consistency checks
        ├─ valid → upsert into target system (idempotent by document hash / message ID) → DONE
        └─ invalid/low confidence → human review queue (UI to correct) → corrections saved (also as eval data)
   failures: retries with backoff for provider errors; DLQ + alarm for poison documents
```

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`OnboardingDocumentsService`](../../packages/backend/libs/domains/seller-onboarding/application/onboarding-documents.service.ts#L37): OnboardingDocumentsService manages presigned uploads and the extraction workflow. _(onboarding-documents.service.ts)_
> - [`handler`](../../packages/backend/apps/lambdas/src/handlers/document-extractor.ts#L24): The document-extractor Lambda handler processes SQS onboarding-documents events and extracts KYC data. _(document-extractor.ts)_
> - [`extractionZod`](../../packages/backend/libs/domains/seller-onboarding/domain/extraction-schema.ts#L48): extractionZod validates the structure of extraction results. _(extraction-schema.ts)_
<!-- theory-links:end -->
### Deep dives
- **Idempotency**: dedupe by email `Message-ID` or document content hash, so retries and duplicate emails don't create duplicate candidates or invoices.
- **Structured output**: provider JSON-schema/tool-call modes + **runtime validation anyway** (LLMs can still return invalid or invented values). Never write unvalidated LLM output into the DB.
- **Throughput and limits**: queue concurrency matched to provider rate limits (Lambda maximum concurrency on the SQS event source), visibility timeout above the LLM timeout, partial batch failures.
- **Cost**: smaller/cheaper model first, escalate to a stronger one only on validation failure; cache results by document hash.
- **Human-in-the-loop**: review UI for low-confidence fields; track correction rates per field as a quality metric.
- **Security**: documents can contain prompt injection ("ignore previous instructions…"), so the extraction step must not have tools that act on systems; treat output as untrusted data; PII handling and retention.
- **Observability**: per-stage success rates, queue age, cost per document, validation failure reasons.

<!-- theory-links:start -->
> [!TIP] In this codebase
> - [`extractionZod`](../../packages/backend/libs/domains/seller-onboarding/domain/extraction-schema.ts#L48): extractionZod does runtime validation of LLM extraction output before it is used. _(extraction-schema.ts)_
> - [`jsonSchemaFor`](../../packages/backend/libs/domains/seller-onboarding/domain/extraction-schema.ts#L28): jsonSchemaFor generates the strict JSON schema passed to the provider for structured output. _(extraction-schema.ts)_
> - [`handler`](../../packages/backend/apps/lambdas/src/handlers/document-extractor.ts#L24): The extractor Lambda handler processes SQS events, which gives queue-based throughput control. _(document-extractor.ts)_
<!-- theory-links:end -->

### Theory
`06-Distributed-Systems/01` §3 (SQS + Lambda pipeline, DLQ, partial batch failures), `01-JavaScript-TypeScript/02` §8 (runtime validation), design 27 (upload pipeline).
