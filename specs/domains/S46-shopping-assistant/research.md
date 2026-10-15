# Research: S46 — decisions behind the plan

No `NEEDS CLARIFICATION` remains. `questions.md` defaults are accepted; the items below are the technical choices the spec left to the plan. Format: Decision / Rationale / Alternatives.

## R-1 Where the provider port lives and how callers migrate
- **Decision**: new `packages/backend/libs/infrastructure/llm` (`@app/infrastructure/llm`), moved with `git mv`-equivalent file copies (no `git checkout`), exporting `LlmModule`, `LLM_PROVIDER`, `LlmProvider`, errors, `LlmCallRecorder`, pure `billableTokens` / `costMicros` / `estimateTokens`, `ScriptedLlmProvider`. `assistant/index.ts` stops exporting provider symbols; consumers found by grep: `seller-onboarding` (module, `extraction.service.ts`, e2e), `apps/projector/src/projector.module.ts`, S47's `answer-model.adapter.ts`, `knowledge.module.ts`, `testing/knowledge.fixtures.ts`.
- **Rationale**: D-14 and FR-041; X.3 allows technical libs generic over payload. One mechanical move keeps risk low; S04 and S47 only change import paths.
- **Alternatives**: keep in `assistant` and re-export (rejected: S04 would keep importing a domain); new package outside `libs` (rejected: no precedent).

## R-2 Metering path: recorder over the outbox, no UsageService
- **Decision**: `LlmCallRecorder.record(...)` builds the `llm.call_completed` v1 envelope (`aggregateId = callId`, `eventId = uuidv5(callId)`), appends with `OutboxService.appendStandalone` (the call is not inside a business transaction), retries 3× with full jitter (`@app/common/core/backoff`), never throws; on exhaustion increments `assistant_metering_failures_total` and logs `callId, subjectId, billableTokens, costMicros`. Returns `{billableTokens, costMicros}` so the caller charges the month counter with the same number.
- **Rationale**: AS-68/71/73; S18 keys identity on `llm:<aggregateId>`.
- **Alternatives**: direct Kafka produce (dual write, rejected IV.4); recorder inside the turn transaction (no relational transaction exists in the turn).
- **S47 compatibility**: the existing `CallRecorderAdapter` becomes a 1-file adapter calling `LlmCallRecorder` with `purpose:'rag'`, `metric:'llm.rag.tokens'`, `scopeId`; the schema keeps `scopeId` and `outcome` optional-tolerant (D-14 closes only then).

## R-3 `CallRecorder` / `AnswerModel` / `Moderator` ports of S47
- **Decision**: they stay declared in `domain/ports.ts` (S47-owned). S46 supplies the replacing implementations: `LlmCallRecorder` (R-2), an `AnswerModel` adapter over `LlmProvider.streamTurn`, and the moderation adapter (R-9). Each S47 adapter file is edited once to delegate; no S47 behavior changes. S47 specs are run once after Phase A and at the end.
- **Alternatives**: move the ports into the lib (rejected: they carry S47 concepts).

## R-4 Circuit breaker
- **Decision**: reuse `CircuitBreaker` (`@app/common/resilience`), one instance per model name (`assistant.model.<id>`), options `{openDurationMs: 30_000, halfOpenCalls: 1, failureRateThreshold: 1, minimumCalls: 5, windowMs: 120_000, consecutiveFailures: 5, isFailure: transient only}`. Add the **additive** `consecutiveFailures?: number` option: when set, the breaker opens on N failures in a row and a success resets the run. `LlmAbortedError`, refusals and `LlmRejectedError` are excluded by `isFailure`. A half-open breaker with `halfOpenCalls: 1` already refuses concurrent probes with `CircuitOpenError`; the model router maps `CircuitOpenError` to "skip this model".
- **Rationale**: AS-46 wording ("consecutive", "success resets") is not expressible with the rate window; the primitive is shared (S13/S43 unaffected as the default is unchanged). Mapping `CircuitOpenError.retryAfterMs` gives AS-47's `Retry-After`. State per process (questions.md LOCAL).
- **Alternatives**: private breaker (forbidden); rate 1.0 only (fails AS-46).

## R-5 Generation store and viewers
- **Decision**: keep the Redis Stream per generation (`XADD` ids `<ms>-<seq>` are the SSE ids) but move behind a `GenerationStore` port. Key `assistant:gen:{<userId>:<messageId>}`-style hash tag keeps meta/stream/liveness in one slot **and puts the owner in the key**, so a foreign lookup is a miss (`404`) with no load-then-compare (G2). Viewer attach = `XREAD` after id with `BLOCK`, bounded by the heartbeat interval; viewer presence = a key with TTL refreshed by each poll (works across processes, AS-27); local viewers get in-process push for latency, the stream is the truth. Duplicate/gap-free resume: read the backlog with `XRANGE (id +`, remember the last id sent, then `XREAD` from that id — never the push path alone.
- **Liveness (AS-30)**: generator refreshes `…:alive` every 1 s with TTL 5 s. A viewer that sees no alive key and no terminal event for > 10 s runs a Lua script: `XADD … error GENERATION_LOST` only if the last stream entry is not terminal, then releases lock and slot (compare-and-delete on the lock value). One script = exactly one terminal event under racing reporters.
- **Terminal ordering (FR-007, AS-31)**: release lock + slot, **then** `XADD` terminal event. The buffer write of the terminal event retries (3×, short) and failure triggers the same loss path instead of `.catch(log)` (G5).
- **Alternatives**: Kafka/Pub-Sub per generation (rejected: ordering/replay cost); in-memory only (rejected: AS-27 second instance).

## R-6 Idempotency for sends
- **Decision**: Redis record `assistant:idem:{<userId>}:<key>` = `{fingerprint, messageId, state}` with TTL = replay window, taken with `SET NX PX` **after ownership (step 4 of AS-06) and before rate limiting**. Same key + same fingerprint + running → `409 idempotency_in_flight {messageId}`; completed or ended → replay the stored events from the generation buffer with `Idempotent-Replay: true`; different fingerprint → `422 idempotency_key_reuse`. Any failure of steps 5–12 deletes the record (compare-and-delete on messageId) — "released when rejected before generating". Fingerprint = SHA-256 over canonical JSON `{conversationId, text (trimmed), lat, lng}` with fixed field order and lat/lng normalised to 6 decimals (so `52.5` and `52.500000` agree); the unit table covers whitespace, field order and number format.
- **Rationale**: AS-63–67. The S53 interceptor stores response bodies, which an SSE stream is not.
- **Edge**: the order AS-06 puts the key check (step 3) before ownership (step 4); the key is only *validated* at step 3 (present, well-formed, conflict check by reading), and *taken* after ownership so a foreign conversation cannot burn a key (AS-06 table: foreign conversation + exhausted allowance → `404`, no key held).

## R-7 Admission pipeline and release discipline
- **Decision**: `AdmissionService.admit(ctx)` runs 12 ordered steps, each returning a `release` closure pushed onto a stack; any throw unwinds the stack in reverse (idempotent releases). Steps: validate → key check → ownership (Scylla point read by `(userId, conversationId)`) → take key → `llm.messages` limit → input moderation → size (counter on conversation row, G13) → allowance → conversation lock (`SET NX PX`, TTL = turn deadline + 30 s, G28) → user slot (Lua `INCR` capped at 3 with TTL) → `llm.provider.tpm` (weighted cost) → breakers. Order is data (an array) so AS-06's table test and the domain spec read the same constant.
- **Quota**: Redis `assistant:quota:{<userId>}:<YYYYMM>` with TTL to month end + 7 days; charge uses a per-call idempotency set (`SADD callId` guard in the same Lua script as `INCRBY`); seed by `checkQuota` when absent (`SET NX`), limit by `EntitlementsService.get`; any billing failure → `503 assistant_unavailable` (fail closed, metric).
- **Clock**: all month/`resetsAt`/TTL math through injected `Clock` (G23).

## R-8 Tools through R1 services
- **Decision**: `AssistantToolExecutor` is rebuilt with zod input schemas (`strict`, closed allowlist), a 5 s `AbortSignal` per call, results trimmed to the documented fields. `search_products` → `ProductSearchService.search({q, filters:{category, maxPriceMinor}, limit ≤ 10 (service limit ≤ 20), surface:'internal'})`. `product_details` → one `ProductQueryService.getProductsByIds([id])`, keep only `ACTIVE && !isSandbox`, description clipped at 600 + `…`, uniform error for all misses. Invalid input errors list **field names only** (G32). Tool failures log tool name + correlation id only (G37). `ProductModule`, `ElasticsearchModule` and `ProductService` imports leave `assistant.module.ts`; it imports `ProductSearchModule`/`ProductModule` barrel modules that **export the services**, not models.
- Check at implementation start: that `ProductQueryService` is provided by a module the assistant can import (`ProductModule` from `@app/domains/catalog`); if the export needs a module, add the module import only.

## R-9 `pickup_near_me` contract
- **Decision**: use the built `PickupSearchService.searchNear({q, lat, lng, radiusKm, limit})` (S19 follow-up). Coordinates come from the request context captured at admission and held only in the in-memory turn context, **never** serialised into the generation buffer, transcript, logs or provider request. Result shape returned to the model: `{hits: [{productId, title, category, priceMinor, currency, nearest:{name, distanceM, quantity}}]}`; the tool description says "prices are integer minor units". If a field is missing in S19's response, map it without touching S19 and note a follow-up.
- **Rationale**: avoid a second export; shape is the S19 one.

## R-10 Moderation port
- **Decision**: reuse S47's `Moderator` interface and `containsSensitiveData` (already in `domain/sensitive-data.ts`, with Luhn/IBAN/secret formats and its 30+30 table spec) so one rule set exists. The shopping half adds a `ModerationBackend` slot (S47's `MODERATION_BACKEND` token) with an input deadline of 200 ms and the closed category set. Without a backend outside production: rule-based only; **production without backend refuses to start** (S47 already asserts this; S46's `AssistantConfigGuard` asserts the same for the assistant). Output: `OutputWindow` keeps the last 256 published characters; each coalesced chunk is checked as `window + chunk`; a flagged chunk is dropped, provider aborted, `refusal{source:'moderation'}`.
- **Alternatives**: second sensitive-data implementation (rejected: duplicate).

## R-11 Persistence and compaction
- **Decision**: turn data stays in memory (`TurnDraft`: user message, round pairs, final assistant message) and is written in one Scylla logged batch (same partition `(userId, conversationId)`) just before the terminal event; the conversation's `message_count` is bumped in the same batch via a counter-free column rewrite guarded by `IF message_count = :n` (LWT) — if the LWT fails the turn ends `error INTERNAL` and nothing is written. Compaction marker moves with `UPDATE … IF compacted_up_to < :m`. Summary uses `LlmProvider.complete` with the summary model, charged and recorded as `callId <messageId>:0`, purpose `summary`.
- **Rationale**: AS-59–61, G13, G15; avoids a `count(*)` per send.
- **Alternatives**: two-phase (write user message first) rejected by questions.md.

## R-12 Config and startup validation
- **Decision**: one `assistant-config.ts` in `libs/common/config` (pattern of `knowledge-config.ts`, with a `.spec.ts` table) parsing: `anthropic_api_key`, `assistant_model`, `assistant_fallback_model`, `assistant_summary_model`, `assistant_effort`, `assistant_detach_grace_ms`, `assistant_max_active_turns`, `assistant_first_token_timeout_ms`, `assistant_turn_timeout_ms`, `assistant_tool_timeout_ms`, `assistant_heartbeat_ms`, `assistant_replay_window_ms`, `assistant_require_distinct_fallback`; removes `assistant_buyer_tokens_per_month`. `LlmModule` selects the Anthropic adapter if and only if a key exists; scripted when `NODE_ENV !== 'production'` **and** the key is absent **and** `llm_provider=scripted` is explicit or the env is test/local; production + scripted → startup error. Price-table check at boot over the three model ids.
- **Rationale**: AS-74, S47 follow-up (keys never parsed).

## R-13 Shutdown and drain
- **Decision**: `GenerationRegistry` tracks in-process runs; `onApplicationShutdown`-style hook (S54 shutdown toolkit: register with the readiness service) flips a `draining` flag (new sends → `503 assistant_unavailable`), waits up to `assistant_drain_ms` (25 s; 1 s in tests), aborts the remainder with `SHUTTING_DOWN` written to their buffers, releases locks and slots.
- Verify the exact S54 hook API at implementation time (read `docs/spec/capabilities/S54-platform-toolkit.md` §shutdown); use it, add no private signal handler.

## R-14 Test strategy details
- Scripted provider grows a small, typed **script DSL** (deltas, tool_use rounds, delays, failure injection per call index, abort recording, usage numbers) in the lib's `testing/`. No mocks of the project's own stores; fault injection wraps ports (VII.9).
- Heavy randomized/loop scenarios (AS-22 50 trials, AS-31 100 runs) use bounded delays and are placed in their own `it` blocks; the full capability suite is run in batches (L-008).
- Two Nest app instances on shared stores for AS-27 reuse the harness pattern of the existing `assistant.e2e-spec.ts` (grep for "second app" at task time; if absent, create a `createSecondApp` helper in `testing/`).
