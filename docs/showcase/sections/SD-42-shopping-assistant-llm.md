# SD-42 — Shopping Assistant (LLM chat, streamed)

Status: ☑ done (typechecked; specs written, not run) · Phase 7 · Depends on: SD-28, SD-24 (quotas), SD-37 (search tool), SD-43 (RAG), F-01

## Marketplace adaptation
"Find me a phone under €800 with the best camera, available for pickup near me" — a Claude-powered assistant that streams answers, can **call read-only tools** (search products, check stock near me, compare specs), remembers the conversation, and respects plan quotas.

## Patterns showcased
| Pattern | Lesson |
|---|---|
| **Streaming**: `POST /assistant/conversations/:id/messages` → `text/event-stream` forwarded from Anthropic SDK stream; heartbeats; `X-Accel-Buffering: no` | 10/10 #42, 02/02 §7 |
| **Client disconnect → abort** provider call (`AbortController`) to stop paying for unread tokens | 10/10 #42 |
| **Resumability**: generation buffered into a Redis Stream keyed by messageId; reconnect resumes from last event id | 10/10 #42 |
| Conversations/messages in **ScyllaDB** (`messages_by_conversation`) + rolling summary of older turns | 10/10 #42, D24 |
| Context management: token counting before send, recent turns + summary; **prompt caching** on system prompt + tool definitions | 10/10 #42 |
| **Tool use** with read-only tools (search, stock-near-me, product details) — no tools that act (prompt-injection safety) | 10/10 #42, 10/10 #44 |
| Rate limits: shared **token bucket per provider key** (tokens/min) + per-shop/user quotas by plan (SD-24); model routing (Haiku for simple, Sonnet/Opus for complex) | 10/10 #42 |
| Reliability: timeouts, retries on 429/529 with backoff, **fallback model**, circuit breaker | 06/03 |
| Observability: time-to-first-token, tokens in/out, cost per tenant (ClickHouse) | 10/10 #42 |
| Moderation of input/output; no secrets/PII in prompts | 10/10 #42 |

## Steps
- [x] Deps: `@anthropic-ai/sdk` 0.131 (model IDs from config: default `claude-opus-5-5`, fallback `claude-sonnet-5-5`, summaries `claude-haiku-4-5` - DOUBTS Q62).
- [x] `LlmProvider` port + Anthropic adapter + scripted adapter for tests / keyless dev.
- [x] Conversation store (Scylla), compaction (synchronous, at turn start - Q63), token counting.
- [x] Assistant service with tool loop, SSE controller, Redis Stream buffer + resume.
- [x] Usage metering → Kafka → ClickHouse; quota guard.
- [x] e2e (scripted provider): ordered stream; disconnect aborts the provider call; tool loop; quota 429 - plus the rows in the Test plan.

## Scale
- Target: 1M DAU × 20 msgs → ~230 msgs/s avg, 3k/s peak; 50k concurrent streams.
- Hot path: Node holds streams (I/O bound); provider rate limits are the real cap → token buckets + queue with 429 back to client when exhausted.
- Capacity: ~5k concurrent streams per instance → 10 instances; cost driver = tokens → routing + caching.

## Implementation notes (2026-10-02)
- **Where:** `libs/common/src/assistant/`, mounted in **apps/sse-gateway** (thousands of held-open streams, I/O bound: the same profile as the topic streams). `LlmCallsProjector` runs in apps/projector.
- **Provider port** (`llm/llm-provider.ts`): SDK types end to end (`BetaMessageParam`, `BetaToolUnion`, `BetaContentBlock`).
  - **Anthropic adapter:**
    - `client.beta.messages.stream()` + `finalMessage()`, with adaptive thinking and `output_config.effort` (default `low` for chat).
    - Prompt caching: a breakpoint on the frozen system prompt (it covers the tools rendered before it), plus top-level automatic caching that follows the growing conversation.
    - `fallbacks: "default"`: refusals are re-run server-side by refusal category.
    - `thinking.block_binding.prefix_mismatch_behavior: "drop_block"`, with dropped blocks logged.
    - SDK retries for 429/5xx/529; typed errors are mapped to `LlmAbortedError` / `LlmUnavailableError`.
  - **Scripted adapter:** queued turns (text chunks, tool uses, hang, refusal, overload). It records every request and abort, so specs assert on what was *sent*.
- **History = append-only, replayed verbatim** (Scylla `assistant_messages_by_conversation`, one row per API message, JSON).
  - Assistant turns are stored *with* their thinking blocks.
  - The system prompt and tools never change, and per-turn facts (whether a location was shared) go into the appended user message.
  - This keeps both the prompt-cache prefix and the preserved-thinking prefix check valid.
  - A tool round (assistant `tool_use` + user `tool_result`) is written in one same-partition batch, so a crash never leaves a dangling `tool_use`.
- **Compaction = "simple compaction":**
  - Trigger: past ~60k tokens. A local chars/4 estimate runs first, and `countTokens` only near the threshold.
  - Effect: the whole visible transcript is summarised by Haiku into ONE `<conversation_summary>` message, and `compacted_upto` is moved, so nothing before it is ever replayed again.
  - Keep-tail compaction was rejected because retained turns' thinking blocks would fail the prefix check (Q63).
- **Tools:** `search_products`, `product_details`, `pickup_near_me`. All are read-only, `strict: true`, with `eager_input_streaming`, and are still zod-validated before running (invalid input → `is_error` tool result).
  - **Location** comes from the request, never from the model.
  - **Parallel calls:** run concurrently; all results go back in one user message.
  - **Round limit:** max 5 rounds; the last one runs with `tool_choice: none` (tools stay declared, so the prefix is unchanged).
  - **Untrusted output:** seller text in tool output is labelled as data in the system prompt; nothing a tool can do acts on the user's behalf.
- **Streaming:** the POST validates, locks (one turn per conversation, Redis `SET NX` + compare-and-delete) and budgets synchronously, so 404/409/429 are normal Problem Details. Generation then runs detached into a **Redis Stream** per message, and the HTTP response is just a viewer.
  - Events: `meta`, `text` (coalesced ~40 ms/256 chars, about one XADD per 10 tokens), `tool`, then `done` / `refusal` / `error`.
  - The lock is released *before* the terminal event, so a client sending immediately after `done` never gets 409.
- **Resume:** `GET /assistant/messages/:id/stream` with `Last-Event-ID`, owner-checked. It uses the topic-gateway algorithm (subscribe, replay the gap, flush without duplicates). A viewer on another instance polls the stream (the rare case).
- **Abort:** when nobody has watched a generation for `assistant_detach_grace_ms` (default 10 s; local viewers counted in memory, remote ones by a 5 s TTL key), or the user hits stop (`POST …/cancel`), the provider call is aborted through `AbortSignal`. The partial answer is not persisted.
- **Fallback model:** if the primary is overloaded or rate-limited *before the first token*, the call is retried once on `assistant_fallback_model`.
- **Quotas:** three layers.
  - `llm.messages` (20/min per user).
  - A monthly token allowance from entitlements (`assistantTokensPerMonth`, default 200k for buyers), charged in Redis after each model call.
  - A fleet-wide provider tokens-per-minute bucket per model. The rate limiter gained a weighted `cost` for this.
- **Metering:**
  - Billing: `usage.recorded` (`llm.chat.tokens` / `llm.summary.tokens`, via the shared `LlmMeter`) → ClickHouse `usage_events`.
  - Observability: `llm.call_completed` → `llm_requests` (+ `llm_daily` MV) with TTFT, tokens, cache tokens, cost in micro-dollars, stop reason and the model that actually answered.

## Test plan
| Scenario | API e2e (`assistant.e2e-spec.ts`) | UI journey (web / mobile) | Unit |
|---|---|---|---|
| Ask → streamed answer in order, persisted | "streams the reply in order…" | web + mobile: ask, watch the answer stream in (happy path) | — |
| Tool loop with real catalogue lookup; missing location → tool error | "tool loop: product_details…" | web: "find me X" shows tool chips, then the answer | — |
| Malformed tool input never executed | "malformed tool input…" | — | — |
| History replayed byte-identically; system/tools frozen | "the next turn replays…" | — | — |
| Disconnect → provider aborted after grace; lock freed; partial not stored | "client disconnect aborts…" | — | — |
| Resume with Last-Event-ID (no gaps/dupes) + stop button | "reconnect with Last-Event-ID…" | mobile: background/foreground mid-answer resumes (happy path) | — |
| Other user: 404 conversation, 403 stream/cancel | "isolation…" | — | — |
| Second message while generating → 409 | "one reply at a time…" | — | — |
| Monthly allowance exhausted → 429 before any provider call | "monthly allowance…" | — | — |
| Per-user requests/min → 429 | "requests per minute…" | — | — |
| Refusal → event, not persisted | "refusal…" | — | — |
| Overload before first token → fallback model | "primary model overloaded…" | — | — |
| Tool rounds bounded (last round tools disabled) | "tool loop is bounded…" | — | — |
| Compaction into one summary; nothing before it replayed | "a long conversation is compacted…" | — | — |
