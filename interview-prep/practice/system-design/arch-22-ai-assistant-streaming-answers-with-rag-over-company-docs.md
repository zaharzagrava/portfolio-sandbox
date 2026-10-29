# arch-22. AI assistant: streaming answers with RAG over company docs

*AI · Medium*

## The question

"Our B2B SaaS adds an AI assistant: employees of each customer company ask questions and get streamed answers grounded in their company's documents from Google Drive, Confluence and Notion, with citations. ~300 customer companies, 200k users, ~20M documents in total. Users must never see content from documents they can't open in the source system. Design it, including ingestion, retrieval, streaming and cost control."

**Then:** "A user asks about salaries and the assistant quotes an HR spreadsheet they don't have access to. And at peak, the LLM provider starts returning 429s."

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- Which LLM? → assume: a hosted model API (one primary provider, a second as fallback); we don't train models; prompts and documents aren't used for training per our provider contract.
- Freshness? → assume: document edits searchable within ~15 min; permission changes within ~5 min.
- Tools/actions? → assume: read-only Q&A; no actions with side effects.
- Data residency? → assume: EU customers' data and inference stay in the EU region.
- Numbers, corpus → assume: 20M docs → ~50M chunks of ~500 tokens. Embeddings at 1536 dims × 4 B ≈ 6 KB each → ~300 GB as float32, ~150 GB as half precision, plus the ANN index. Daily changes ~500k docs → ~1.5M chunks re-embedded/day.
- Numbers, queries → assume: 200k users × 5 questions/day = 1M/day ≈ 12/s avg, ~50/s peak. ~4k input tokens (instructions + retrieved chunks) + ~400 output tokens per answer ≈ 4.4B tokens/day. Cost per answer and provider token-per-minute limits drive the design.

## Design

**1. Ingestion.**
1. Connectors per source (webhooks or change APIs where available, polling otherwise) → `documents(id, customer_id, source, external_id, title, url, content_hash, updated_at)` and `doc_acl(doc_id, principal_id)` with principals = user and group IDs as the source system defines them.
2. Extract text (PDF, sheets, slides), split by headings into ~500-token chunks with a little overlap; skip unchanged chunks by content hash.
3. Embed in batches (queue, retries, per-provider rate limit), store:
```sql
chunks(id, customer_id, doc_id, ord int, text, tokens int, embedding halfvec(1536),
       principals uuid[])                -- copied from doc_acl for filtering
-- partitioned by customer_id; HNSW index per partition (halfvec_cosine_ops), GIN on principals
```
pgvector supports HNSW on `halfvec` up to 4,000 dimensions (2,000 for `vector`).

**2. Question → answer.**
1. `POST /assistant/messages` → resolve the user's principals (their ID + groups from the source systems, cached 5 min).
2. Retrieve: hybrid search within the customer's partition and filtered by `principals && $userPrincipals`: vector top 50 + Postgres full-text top 50, fused, reranked to top 8.
3. **Re-check access** for those 8 docs against the current ACL (and the source API for sensitive sources) right before building the prompt.
4. Prompt: instructions, retrieved chunks in delimited blocks marked as untrusted data, the question, recent turns. Stream the model's output to the browser over SSE (`text/event-stream`), with citation markers mapped to doc URLs.
5. On client disconnect (`req.on('close')`), abort the upstream call with `AbortController` so we stop paying for tokens. Persist the final (or partial) answer and the retrieved doc IDs for audit.

**3. Streaming details.** Disable proxy buffering (`X-Accel-Buffering: no`, no gzip buffering on the stream), send an SSE comment heartbeat every ~15 s during long retrieval so idle timeouts (ALB default 60 s) don't cut the connection.

**4. Cost and limits.** Per-customer token budgets (token bucket on estimated input + max output tokens), per-user request rate limit, prompt-prefix caching where the provider supports it, smaller model for query rewriting and reranking.

**5. Quality.** A golden question set per pilot customer; measure retrieval recall@8 and answer faithfulness on every prompt/model/chunking change.

## Deep dives

**1. The HR leak (twist, part 1).** Typical causes, in order of likelihood: (a) the ACL wasn't in the retrieval filter at all, or a "shared with anyone in the company with the link" setting was mapped to "everyone"; (b) the permission was removed in Drive but our ACL sync lagged; (c) a semantic answer cache shared across users returned someone else's answer; (d) HNSW post-filtering returned too few permitted chunks and a fallback path skipped the filter. Chosen: filter inside the retrieval query, re-check cited docs at answer time, map link-sharing to "users who opened the link" only, permission-change webhooks plus a nightly full ACL reconciliation, no cross-user answer cache, and an audit log of retrieved doc IDs per answer so we can tell who saw what. Rejected: asking the model to "only use documents the user can access" (it can't know, and instructions aren't a security boundary).

**2. Filtered vector search.** HNSW finds nearest neighbors first and filters after, so with a restrictive filter (a user who can see 2% of the company's chunks) it can return fewer than k results. Chosen: per-customer partitions (the biggest filter applied structurally), pgvector 0.8's iterative index scans (`hnsw.iterative_scan`) so the scan continues until enough rows pass the filter, and full-text search as a second retriever. Trigger to move off Postgres: a single customer beyond ~10-20M chunks or latency SLOs we can't meet; then a dedicated vector store with native filtered search.

**3. Provider 429s (twist, part 2).** Limits are per organization in requests and tokens per minute. Chosen: our own token-bucket admission in front of the provider (so we queue fairly by customer instead of letting the provider reject at random), priority for interactive questions over background jobs (re-embedding, summaries), retry with `Retry-After` and jitter, then fail over to the secondary provider/region or a smaller model with a visible "reduced quality" note. Ask the provider for higher limits before launches. Rejected: unbounded client retries (makes the 429 storm worse).

## Traps

- Filtering permissions after generation, or in the prompt.
- A shared semantic cache across users: one user's answer, built from their documents, served to another.
- Treating retrieved document text as instructions: a doc saying "ignore previous instructions and…" is indirect prompt injection; keep it as delimited data and give the model no side-effecting tools.
- Not aborting the upstream LLM call when the user closes the tab: you pay for tokens nobody reads.
- Re-embedding unchanged documents on every sync.
- Shipping prompt changes without an evaluation set: quality regresses silently.

## Say it (60–90 s)

Ingestion runs per source: connectors pick up changes, store each document with its access list from the source system, split text by headings into about five-hundred-token chunks, skip unchanged chunks by hash, and embed in batches into pgvector, partitioned by customer, with the allowed principals copied onto each chunk. That's about fifty million chunks, around a hundred fifty gigabytes in half precision. For a question, I resolve the user's groups, then run hybrid retrieval, vector plus full-text, inside their company's partition and filtered by those principals, rerank to the top eight, and re-check access to those documents right before building the prompt. Retrieved text goes in as delimited, untrusted data. The answer streams to the browser over server-sent events with citations; if the user disconnects I abort the upstream call to stop paying. The HR leak means the permission filter was missing or stale, or an answer cache was shared across users: the fix is filtering in the query, re-checking at answer time, fast permission sync, no shared cache, and an audit trail of what was retrieved. For 429s, I admit requests through my own per-customer token budgets, prioritize interactive questions, and fall back to a second provider or smaller model.

## Follow-ups

**Q:** How do you measure whether answers are good?
**A:** Offline: a golden set with expected source docs (retrieval recall) and graded answers (faithfulness to retrieved text, using human review plus an LLM grader calibrated against it). Online: thumbs up/down, citation click-through, "no answer" rate.

**Q:** A customer deletes a document. When is it gone?
**A:** The connector sees the delete (or the nightly reconciliation does), deletes chunks and embeddings, and logs it; stored conversations that cited it keep only the citation title. Document the deletion SLA in the contract.

**Q:** Why not fine-tune a model on each company's documents instead?
**A:** Fine-tuning can't enforce per-document permissions, goes stale with every edit, and can't cite sources reliably. Retrieval keeps permissions and freshness at query time.

</details>

## Theory in the notes

- [10-system-design/10-ai-applications.md](../../10-system-design/10-ai-applications.md)
- [05-security/02-authentication-authorization.md](../../05-security/02-authentication-authorization.md)
- [03-databases/01-postgres-indexing-and-query-planning.md](../../03-databases/01-postgres-indexing-and-query-planning.md)
- [04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md](../../04-api-design/03-idempotency-pagination-rate-limiting-webhooks.md)
