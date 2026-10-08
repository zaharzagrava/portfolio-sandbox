# Test plan: S46 — Streamed shopping assistant (constitution VII.8)

One row per acceptance scenario of `spec.md`. A scenario is proven at the lowest layer that can prove it; a layer cell with `—` means the scenario is not tested there. UI journeys are happy paths only (VII.7), once per client that has the flow. The model is always the scripted provider (system edge); Postgres, Redis, Scylla, Kafka stand-ins, the outbox and ClickHouse are real; time is frozen except where a row says the clock advances; every spec resets state in `beforeEach` and parses responses with the `packages/contracts` schema (VII.6).

Spec files (all under `packages/backend/libs/domains/assistant/` unless a path is given; each top-level `describe` names its feature):

| Short name | File | Top-level `describe` |
|---|---|---|
| TURN | `assistant-turn.e2e-spec.ts` | `Shopping assistant: turns, conversations, idempotency` |
| TOOLS | `assistant-tools.e2e-spec.ts` | `Shopping assistant: read-only tools` |
| RESUME | `assistant-resume.e2e-spec.ts` | `Shopping assistant: resumable streams, cancel, abort, shutdown` |
| LIMITS | `assistant-limits.e2e-spec.ts` | `Shopping assistant: quotas and limits` |
| RESIL | `assistant-resilience.e2e-spec.ts` | `Shopping assistant: fallback model, breaker, timeouts` |
| MODER | `assistant-moderation.e2e-spec.ts` | `Shopping assistant: moderation and data hygiene` |
| CONTEXT | `assistant-context.e2e-spec.ts` | `Shopping assistant: transcript, compaction, atomic persistence` |
| METER | `assistant-metering.e2e-spec.ts` | `Shopping assistant: metering and observability` |
| ADAPTER | `packages/backend/libs/infrastructure/llm/llm-provider.e2e-spec.ts` | `LLM provider port and Anthropic adapter` |
| BOOT | `assistant-platform.e2e-spec.ts` | `Shopping assistant: configuration, shutdown, boundaries` |
| WEB | `packages/web/tests/assistant.spec.ts` (Playwright) | `Shopping assistant sheet` |
| UNIT | files under `domain/` of this lib and `libs/infrastructure/llm/` (`*.spec.ts`) | named per file |

Static layer (VII.1) for every row: `tsc --noEmit`, ESLint, `pnpm check:boundaries` and `pnpm check:table-ownership --strict` pass for the touched packages.

| Scenario | API e2e (deep layer) | UI journey (happy path only) | Unit (pure logic only) |
|---|---|---|---|
| AS-01 ordered stream, atomic persistence | TURN: "streams meta → text… → done in order and persists the turn" | WEB: ask "find me a phone", answer streams in, shows in history | — |
| AS-02 stream protocol, heartbeat | TURN: "headers, retry hint, heartbeat, strictly increasing ids, no cost in done" | — | — |
| AS-03 validation classes | TURN: "rejects invalid input classes with no side effect" (`it.each` over the table) | — | — |
| AS-04 unauthenticated | TURN: "401 on every endpoint" (`it.each` over 8 routes) | — | — |
| AS-05 cross-user isolation | TURN: "another user gets 404 for conversation, history, delete, stream and cancel" | — | — |
| AS-06 admission order | LIMITS: "admission checks run in the documented order" (`it.each` over combined failures) | — | — |
| AS-07 conversations create/list | TURN: "creates and lists conversations with a keyset cursor" | — | — |
| AS-08 history shape | TURN: "history hides thinking, context block and tool output" | — | — |
| AS-09 delete conversation | TURN: "deletes own conversation; 409 while generating; 404 foreign" | — | — |
| AS-10 text coalescing | — | — | UNIT `application/text-coalescer.spec.ts`: fake timers, 400 deltas → ≤ 1 event per 40 ms / 256 chars, order kept, flush before terminal |
| AS-11 search via S32 | TOOLS: "search_products goes through ProductSearchService and returns trimmed hits" | WEB: tool chip shows then answer (shared with AS-01 journey) | — |
| AS-12 product details via S05 | TOOLS: "product_details hides archived, sandbox and unknown ids identically" | — | — |
| AS-13 pickup near me, location privacy | TOOLS: "pickup_near_me uses request coordinates; coordinates appear nowhere" | — | — |
| AS-14 no location | TOOLS: "pickup_near_me without location is an error result and S19 is not called" | — | — |
| AS-15 malformed input / unknown tool | TOOLS: "invalid tool input and unknown tools are never executed" | — | UNIT `application/assistant-tools.spec.ts`: input-schema table (`it.each`) |
| AS-16 parallel tool calls | TOOLS: "parallel tools run concurrently; results in one message in call order" | — | — |
| AS-17 bounded loop | TOOLS: "5th model call has tools disabled; a misbehaving model ends TOOL_LOOP_LIMIT" | — | — |
| AS-18 tool failure / timeout | TOOLS: "a failing or slow tool yields a generic error result" (fault injected at S32 double) | — | — |
| AS-19 prompt-injection safety | TOOLS: "seller text only inside tool_result; prompt and tools unchanged" | — | UNIT `application/assistant-tools.spec.ts`: closed allowlist of 3 tool names; no URL/recipient fields in schemas |
| AS-20 cut-off tool input | TOOLS: "max_tokens with tool_use never runs the tool" | — | — |
| AS-21 pause_turn | TOOLS: "pause_turn continues and counts toward the round bound" | — | — |
| AS-22 resume without gaps/dupes | RESUME: "reconnect with Last-Event-ID resumes exactly once, in order" (+ 50-trial randomized race) | WEB: connection drop mid-answer resumes and shows the full text | UNIT `infra/stream-id.spec.ts`: `compareStreamIds` table (numeric, not lexical) |
| AS-23 resume from start / finished | RESUME: "replays whole generation without Last-Event-ID; terminal id returns empty stream" | — | — |
| AS-24 malformed Last-Event-ID | RESUME: "400 invalid_last_event_id; newer-than-newest id waits for live events" | — | UNIT `infra/stream-id.spec.ts`: id format table |
| AS-25 expired / unknown generation | RESUME: "404 generation_not_found after the replay window; answer still in history" (clock advances 16 min) | — | — |
| AS-26 abort when nobody watches | RESUME: "disconnect aborts the provider after grace; reconnect within grace does not" | — | — |
| AS-27 several viewers, other process | RESUME: "second tab keeps it alive; viewer on a second app instance sees the same events" (two Nest apps on shared stores) | — | — |
| AS-28 stop button | RESUME: "cancel aborts within 1 s, 202 twice, nothing persisted" | WEB: stop button ends the answer | — |
| AS-29 illegal transitions | RESUME: "cancel of a finished generation is 409 and does not change the outcome" | — | — |
| AS-30 generator crash | RESUME: "lost generator yields one GENERATION_LOST; lock reclaimed; two racing reporters write one event" | — | — |
| AS-31 lock freed before terminal | RESUME: "next send right after the terminal event is never 409" (100 runs) | — | — |
| AS-32 monthly allowance | LIMITS: "exhausted allowance → 429 quota_exceeded with Retry-After; 999/1000 admitted" | — | — |
| AS-33 limit from billing, fail closed | LIMITS: "limit comes from S18 entitlements; unreadable → 503; cold counter seeded from checkQuota" (S18 service is the system edge fake only if S18 is not loaded; otherwise real billing module) | — | — |
| AS-34 UTC month boundary | LIMITS: "month rolls at 00:00 UTC" (frozen clock, two instants) | — | UNIT `application/month.spec.ts`: month key and `resetsAt` table incl. year end and leap day |
| AS-35 charging per call | LIMITS: "each call charged once; replayed charge ignored; aborted call charged an estimate" | — | UNIT `infra/llm/billable-tokens.spec.ts` shares AS-62's table |
| AS-36 requests per minute | LIMITS: "21st message in a minute → 429 rate_limited; limiter down → 503" | — | — |
| AS-37 provider token budget | LIMITS: "exhausted budget → 429 assistant_busy; limiter down → fails open" | — | UNIT `application/admission-cost.spec.ts`: weighted-cost table, capped at the budget |
| AS-38 provider 429 cooldown | RESIL: "provider 429 with Retry-After cools the model fleet-wide" | — | — |
| AS-39 concurrent replies per user | LIMITS: "4 parallel sends → exactly 3 accepted; slot count returns to 0" (`Promise.all`) | — | — |
| AS-40 one reply per conversation | LIMITS: "two sends at once → one 200, one 409; one turn persisted" (`Promise.all`) | — | — |
| AS-41 conversation full | LIMITS: "388 messages refused, 387 accepted" | — | — |
| AS-42 usage read | LIMITS: "GET /assistant/usage reads the admission counter and limit" | — | — |
| AS-43 fallback before first token | RESIL: "primary overloaded before the first token → fallback answers; two records" | — | — |
| AS-44 no fallback after first token | RESIL: "failure after streamed text ends PROVIDER_UNAVAILABLE, nothing persisted" | — | — |
| AS-45 both unavailable | RESIL: "both models failing → PROVIDER_UNAVAILABLE after exactly two attempts" | — | — |
| AS-46 circuit breaker | RESIL: "5 failures open the primary; zero primary calls; one half-open probe closes or reopens" (forced path, VII.9) | — | UNIT `libs/common/circuit-breaker/circuit-breaker.spec.ts`: state-machine table (`it.each`) + `fast-check` property: never two concurrent half-open probes |
| AS-47 everything open | RESIL: "both breakers open → 503 assistant_unavailable with Retry-After, no side effect" | — | — |
| AS-48 non-transient errors | RESIL: "400/401 are not retried, not fallen back, not counted by the breaker" | — | — |
| AS-49 timeouts | RESIL: "first-token, whole-call and turn deadlines abort and report" (clock advances) | — | — |
| AS-50 adapter retry rules | ADAPTER: "retries 429/5xx/reset before first token ≤ 2 with Retry-After; never 4xx; never after first token; maxRetries 0 → one attempt" (local HTTP double) | — | UNIT `infra/llm/backoff.spec.ts`: full-jitter bounds table |
| AS-51 provider refusal | RESIL: "refusal event; nothing persisted; next turn valid" | — | — |
| AS-52 input moderation | MODER: "flagged input → 422 input_rejected, no side effect, text not logged" | — | — |
| AS-53 sensitive data | MODER: "card number and key-shaped input → 422 sensitive_data" (one positive, one negative sample) | — | UNIT `domain/sensitive-data.spec.ts`: 30 positive / 30 negative table + `fast-check` Luhn property |
| AS-54 output moderation | MODER: "flagged chunk is not published; refusal source moderation; nothing persisted; split phrase caught" | — | UNIT `domain/output-window.spec.ts`: 256-char context window table |
| AS-55 moderator unavailable | MODER: "input → 503; mid-reply → MODERATION_UNAVAILABLE; nothing persisted" | — | — |
| AS-56 no secrets/PII in prompts | MODER: "provider requests contain no email, ids, token, IP, coordinates" (scan of every recorded request) | — | — |
| AS-57 logs hygiene | MODER: "captured logs contain no text, answers, tool data, coordinates or keys" | — | — |
| AS-58 append-only replay, frozen prefix | CONTEXT: "third turn replays turns 1–2 byte-identically; system and tools frozen; cache breakpoint present" | — | — |
| AS-59 compaction | CONTEXT: "a long conversation is compacted into one summary; marker moves forward; two racing turns compact once" | — | UNIT `application/compaction.spec.ts`: threshold decision table (estimate vs count, count failure falls back) |
| AS-60 compaction failure | CONTEXT: "summary failure fails the turn, records no compaction" | — | — |
| AS-61 atomic turn persistence | CONTEXT: "only `done` persists, in one batch; every other outcome leaves zero rows" (`it.each` over 7 outcomes; cancel during second tool round) | — | — |
| AS-62 token estimate and arithmetic | — | — | UNIT `infra/llm/billable-tokens.spec.ts`: formula table + `fast-check` monotonic, non-negative, integer |
| AS-63 replay of completed send | TURN: "same key and body replays stored events; no model call, charge or second turn" | — | — |
| AS-64 same key in flight | TURN: "same key while generating → 409 idempotency_in_flight with messageId" | — | — |
| AS-65 same key, different body | TURN: "different text, location or conversation → 422 idempotency_key_reuse" | — | UNIT `domain/request-fingerprint.spec.ts`: fingerprint table (whitespace, field order, number format) |
| AS-66 key required | TURN: "missing or empty key → 422 idempotency_key_required" | — | — |
| AS-67 key scope and release | TURN: "keys are per user; rejected sends release the key; failed generation keeps it" | — | — |
| AS-68 one record per call, durable | METER: "four calls → four outbox rows with callId <messageId>:<n>, deterministic eventId, S18 fields" | — | — |
| AS-69 consumers idempotent, DLQ | METER: "projector: duplicate delivery → one llm_requests row; invalid payload → DLQ, no row" (VII.4) | — | — |
| AS-70 TTFT and metrics | METER: "ttft null without text; metrics move on forced paths; active_streams returns to 0; no user labels" | — | — |
| AS-71 outbox failure | METER: "outbox append failing 3 times: turn completes, failure counted and logged with callId" (forced path, VII.9) | — | — |
| AS-72 cost table | — | — | UNIT `infra/llm/pricing.spec.ts`: per-model usage table → integer micros |
| AS-73 event contract | METER: "payload parses with llmCallCompletedV1; additive fields present" | — | — |
| AS-74 configuration validated | BOOT: "invalid configuration table fails startup naming the key" (`it.each`) | — | UNIT `infra/llm/pricing.spec.ts`: unknown model → error |
| AS-75 graceful shutdown | BOOT: "SIGTERM: readiness fails, new sends 503, running replies drained then SHUTTING_DOWN" | — | — |
| AS-76 boundaries | BOOT: "dependency-cruiser and table-ownership reports are clean for this lib" (runs the two checks) | — | — |
| AS-77 provider port shared | ADAPTER: "complete() with maxRetries 0, timeout, output schema and document block: one attempt, typed errors, one extraction record" | — | — |

## Counts and coverage

- Every acceptance scenario AS-01 … AS-77 appears exactly once above; edge cases in the spec's index each map to one row.
- Mandatory API cases per endpoint (VII.3): happy path (AS-01, 07, 08, 09, 22, 28, 42), validation classes (AS-03), `401` (AS-04), cross-user `404` (AS-05), idempotency replay / in-flight / different body (AS-63–AS-65), rate limit `429` (AS-36), state-transition guard `409` (AS-29, AS-40, AS-09), concurrent `Promise.all` invariant protection (AS-39, AS-40).
- Fallback and degradation paths each have a forcing test (VII.9): fallback model (AS-43), circuit breaker (AS-46–AS-47), limiter fail modes (AS-36, AS-37), provider cooldown (AS-38), outbox failure (AS-71), moderation failure (AS-55).
- Async consumers (VII.4): `llm-calls-log` projector (AS-69). Billing's `llm.call_completed` consumer is tested in S18.
- Every API e2e asserts the response body **and** persisted state: Scylla rows, Redis keys (lock, slot, counter, key records), outbox rows, ClickHouse rows, or emitted metrics.
- The web journeys are four rows of one Playwright file with an isolated user per test and no fixed sleeps.
