---
id: S46
title: Streamed shopping assistant (read-only tools, resumable streams, allowance, fallback model, moderation, metering, shared model provider port)
kind: capability
status: draft
depends_on: [S01, S05, S19, S32, S50, S53, S54]
concepts: [problem-json-errors, rate-limit-policy, idempotency-key, outbox-task-queue, projection-and-replay]
models: []
scope:
  - packages/backend/libs/domains/assistant/api/assistant*.ts
  - packages/backend/libs/domains/assistant/api/zod.pipe.ts
  - packages/backend/libs/domains/assistant/application/assistant*.ts
  - packages/backend/libs/domains/assistant/application/allowance.service.ts
  - packages/backend/libs/domains/assistant/application/conversation.service.ts
  - packages/backend/libs/domains/assistant/application/generation.service.ts
  - packages/backend/libs/domains/assistant/application/metering.service.ts
  - packages/backend/libs/domains/assistant/application/model-router.ts
  - packages/backend/libs/domains/assistant/application/turn-runner.ts
  - packages/backend/libs/domains/assistant/application/turn-log.ts
  - packages/backend/libs/domains/assistant/domain/assistant-ports.ts
  - packages/backend/libs/domains/assistant/domain/admission.ts
  - packages/backend/libs/domains/assistant/domain/compaction.ts
  - packages/backend/libs/domains/assistant/domain/conversation-cursor.ts
  - packages/backend/libs/domains/assistant/domain/generation-state.ts
  - packages/backend/libs/domains/assistant/domain/month.ts
  - packages/backend/libs/domains/assistant/domain/output-window.ts
  - packages/backend/libs/domains/assistant/domain/request-fingerprint.ts
  - packages/backend/libs/domains/assistant/domain/stream-id.ts
  - packages/backend/libs/domains/assistant/domain/text-coalescer.ts
  - packages/backend/libs/domains/assistant/infra/redis-generation.store.ts
  - packages/backend/libs/domains/assistant/infra/redis-admission.adapter.ts
  - packages/backend/libs/domains/assistant/infra/redis-quota.counter.ts
  - packages/backend/libs/domains/assistant/infra/scylla-conversation.repository.ts
  - packages/backend/libs/domains/assistant/infra/moderation.adapter.ts
  - packages/backend/libs/domains/assistant/infra/llm-calls.projector.ts
  - packages/backend/libs/domains/assistant/rate-limit-policies.ts
  - packages/backend/libs/domains/assistant/assistant.module.ts
  - packages/backend/libs/domains/assistant/assistant-projector.module.ts
  - packages/backend/libs/infrastructure/llm/**
  - packages/contracts/src/assistant/conversation.ts
  - packages/contracts/src/assistant/history.ts
  - packages/contracts/src/assistant/send-message.ts
  - packages/contracts/src/assistant/stream-events.ts
  - packages/contracts/src/assistant/usage.ts
  - packages/contracts/src/assistant/llm-call-completed.ts
---
# S46 - Streamed shopping assistant
## Purpose
A signed-in shopper talks to an assistant that finds, compares and recommends marketplace products. The answer streams to the screen as it is written and survives a dropped connection. The assistant looks things up with three read-only tools and never acts for the shopper. It respects the shopper's monthly token allowance and request limits, keeps answering through a fallback model when the main model struggles, refuses unsafe input and output, and records one usage fact for every model call. The model provider port and its adapters live in an infrastructure library that the help center (S47) and document extraction (S04) share.

## Today
The shopping half of the `assistant` domain is built on ports (`domain/assistant-ports.ts`) with Redis, Scylla and moderation adapters bound in `assistant.module.ts`; the model-provider classes live in `@app/infrastructure/llm`.
- A shopper creates, lists (keyset-paged), reads and deletes conversations, sends a message with an `Idempotency-Key` and reads the streamed reply (events `meta`, `text`, `tool`, `done`, `refusal`, `error`), resumes with `Last-Event-ID`, cancels, and reads the usage `{used, limit, resetsAt}`.
- Three read-only tools (`search_products`, `product_details`, `pickup_near_me`) run in a loop of at most five model calls through the exported services of search (S32), products (S05) and pickup (S19); the last call forbids tools.
- A send passes the admission steps in one fixed order; every rejection leaves nothing behind. Input is moderated before any lock and output chunk by chunk before it is published.
- A reply lock keeps one reply per conversation and at most three replies run per user. A viewer that stays away for the grace period aborts the reply; a generation whose process is lost is reported once and its lock and slot are reclaimed.
- The transcript is replayed unchanged and written only when a turn ends `done`; above 60,000 tokens it is compacted into one summary.
- The allowance limit comes only from billing (S18); the month counter is seeded from billing's exact usage. A rate `llm.messages` and a fleet-wide `llm.provider.tpm` budget are taken at admission.
- Each model has a circuit breaker and a provider-imposed cooldown shared by all instances; the primary falls back once to a second model before the first token.
- Every model call appends one `llm.call_completed` v1 record through the outbox; the analytics projector stores it in ClickHouse.

## Entry points
- `POST /api/assistant/conversations`, `GET /api/assistant/conversations` and `DELETE /api/assistant/conversations/:id`. [code: packages/backend/libs/domains/assistant/api/assistant.controller.ts#AssistantController]
- `GET /api/assistant/conversations/:id/messages` and `GET /api/assistant/usage`. [code: packages/backend/libs/domains/assistant/api/assistant.controller.ts#AssistantController]
- `POST /api/assistant/conversations/:id/messages`, a `text/event-stream` answer. [code: packages/backend/libs/domains/assistant/api/assistant-stream.ts#AssistantStreamer]
- `GET /api/assistant/messages/:messageId/stream` and `POST /api/assistant/messages/:messageId/cancel`. [code: packages/backend/libs/domains/assistant/infra/redis-generation.store.ts#RedisGenerationStore]
- Event `llm.call_completed` v1 on the outbox, consumed by billing (S18) and by the analytics projector. [code: packages/backend/libs/domains/assistant/infra/llm-calls.projector.ts#LlmCallsProjector]
- The shared model provider port `LlmProvider` and the call recorder, imported by S04 and S47. [code: packages/backend/libs/infrastructure/llm/llm-provider.ts#LLM_PROVIDER]

## Rules
- **S46.R-01** A send MUST be validated, pass the admission steps in one fixed order, then answer `200` with an event stream of `meta`, `text`, `tool` and exactly one of `done`, `refusal` or `error`, with strictly increasing event ids. [proof: S46 AS-01, S46 AS-06] [code: packages/backend/libs/domains/assistant/application/assistant-turn.service.ts#AssistantTurnService]
- **S46.R-02** The send body MUST be `text` of 1 to 4000 characters after trimming, with `lat` and `lng` both present or both absent, and any unknown field MUST be refused naming the field. [proof: S46 AS-03] [code: packages/contracts/src/assistant/send-message.ts#assistantSendMessageRequestSchema]
- **S46.R-03** The header `Idempotency-Key` MUST be 1 to 128 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`, and a conversation id MUST be a time-based UUID. [proof: S46 AS-03] [code: packages/contracts/src/assistant/send-message.ts#assistantIdempotencyKeySchema]
- **S46.R-04** A rejection before generation starts MUST be a problem document with a stable `code` and MUST leave no provider call, stored message, charge, reply lock, active-reply slot or held idempotency key. [proof: S46 AS-06] [code: packages/backend/libs/domains/assistant/application/assistant-turn.service.ts#AssistantTurnService]
- **S46.R-05** The admission checks MUST run in this order and the first failure decides the answer: authentication, validation, idempotency key, ownership, request rate, input moderation, conversation size, allowance, reply lock, active-reply slot, provider token budget, circuit breakers. [proof: S46 AS-06] [code: packages/backend/libs/domains/assistant/domain/admission.ts#ADMISSION_STEPS]
- **S46.R-06** Every route MUST answer `401` without credentials, and a conversation or generation of another user MUST answer the same `404` as an unknown one, with the owner in every lookup predicate. [proof: S46 AS-04, S46 AS-05] [code: packages/backend/libs/domains/assistant/api/assistant.controller.ts#AssistantController]
- **S46.R-07** Every stream event MUST parse as one of `meta`, `text`, `tool`, `done`, `refusal` or `error`, and `done` MUST carry the stop reason, usage and allowance but no cost, model name or cache counter. [proof: S46 AS-01, S46 AS-02] [code: packages/contracts/src/assistant/stream-events.ts#assistantStreamEventSchema]
- **S46.R-08** A reply stream MUST open with the headers that stop proxy buffering and `retry: 2000`, and MUST write a `: ping` comment without an id while silent for the heartbeat interval of at most 25 seconds. [proof: S46 AS-02] [code: packages/backend/libs/domains/assistant/api/assistant-stream.ts#AssistantStreamer]
- **S46.R-09** Text events MUST be coalesced to at most one per 40 milliseconds or 256 characters in order, and the last one MUST precede the terminal event. [proof: S46 AS-10] [code: packages/backend/libs/domains/assistant/domain/text-coalescer.ts#TextCoalescer]
- **S46.R-10** The reply MUST be generated independently of the HTTP response that started it, and the buffer MUST keep every event for 15 minutes after the generation ends. [proof: S46 AS-22, S46 AS-23, S46 AS-25] [code: packages/backend/libs/domains/assistant/infra/redis-generation.store.ts#RedisGenerationStore]
- **S46.R-11** A viewer that attaches with a well-formed `Last-Event-ID` MUST receive each later event exactly once in order, a malformed id MUST be `400` `invalid_last_event_id`, and an unknown or expired generation MUST be `404` `generation_not_found`. [proof: S46 AS-22, S46 AS-24, S46 AS-25] [code: packages/contracts/src/assistant/stream-events.ts#assistantLastEventIdSchema]
- **S46.R-12** A generation MUST be aborted with `error CANCELLED` when no viewer attached for the grace period or the owner cancels, and a cancel of a finished generation MUST answer `409` `generation_finished`. [proof: S46 AS-26, S46 AS-27, S46 AS-28, S46 AS-29] [code: packages/backend/libs/domains/assistant/application/generation.service.ts#GenerationService]
- **S46.R-13** A generation whose process is lost MUST end with exactly one `error GENERATION_LOST` and free its reply lock and slot. [proof: S46 AS-30] [code: packages/backend/libs/domains/assistant/application/generation.service.ts#GenerationService]
- **S46.R-14** The reply lock and the active-reply slot MUST be released before the terminal event is published. [proof: S46 AS-31] [code: packages/backend/libs/domains/assistant/application/turn-runner.ts#TurnRunner]
- **S46.R-15** A user MUST be able to create, list, read and delete their own conversations, with a title of 1 to 120 characters that defaults to "New chat", and a list that is keyset-paged newest first with `limit` 1 to 50 (default 20). [proof: S46 AS-03, S46 AS-07] [code: packages/contracts/src/assistant/conversation.ts#assistantConversationListQuerySchema]
- **S46.R-16** Deleting a conversation MUST remove all its messages, answer `204`, and answer `409` `turn_in_progress` while a reply is generated. [proof: S46 AS-09] [code: packages/backend/libs/domains/assistant/application/conversation.service.ts#ConversationService]
- **S46.R-17** The history MUST expose only `id`, `turnId`, `role`, visible `text` and tool names, never thinking, raw tool input or output, or the per-turn context block. [proof: S46 AS-08] [code: packages/contracts/src/assistant/history.ts#assistantHistorySchema]
- **S46.R-18** A turn MUST be persisted only when it ends `done`, in one batch before the terminal event, and every other outcome MUST leave no row of the turn. [proof: S46 AS-01, S46 AS-61] [code: packages/backend/libs/domains/assistant/infra/scylla-conversation.repository.ts#ScyllaConversationRepository]
- **S46.R-19** The transcript MUST be replayed append-only and unchanged, the system prompt and tool list MUST be identical in every request, and per-turn facts MUST appear only in the appended user message. [proof: S46 AS-58] [code: packages/backend/libs/domains/assistant/application/turn-runner.ts#TurnRunner]
- **S46.R-20** When the replayed transcript would pass 60,000 tokens, the whole transcript MUST be replaced by one summary, a failed summary MUST end the turn with `error PROVIDER_UNAVAILABLE`, and the compaction marker MUST only move forward. [proof: S46 AS-59, S46 AS-60] [code: packages/backend/libs/domains/assistant/domain/compaction.ts#decideCompaction]
- **S46.R-21** A conversation MUST hold at most 400 stored messages, and a send MUST be refused with `409` `conversation_full` when a largest turn of 12 messages would not fit. [proof: S46 AS-41] [code: packages/backend/libs/domains/assistant/infra/scylla-conversation.repository.ts#MAX_MESSAGES]
- **S46.R-22** The assistant MUST expose exactly three tools, `search_products`, `product_details` and `pickup_near_me`, with fixed definitions and no tool that changes state or reads private user data. [proof: S46 AS-19] [code: packages/backend/libs/domains/assistant/application/assistant-tools.ts#ASSISTANT_TOOLS]
- **S46.R-23** Tool input MUST be checked before the tool runs, and an unknown tool, a malformed input or an input cut off by the token limit MUST never run. [proof: S46 AS-15, S46 AS-20] [code: packages/backend/libs/domains/assistant/application/assistant-tools.ts#AssistantToolCatalog]
- **S46.R-24** Tool data MUST come only through the exported services of search (S32), products (S05) and pickup (S19), and a product that is not active, is a [sandbox product](../terms/sandbox-product.md) or is unknown MUST give the same error result. [proof: S46 AS-11, S46 AS-12, S46 AS-14] [code: packages/backend/libs/domains/assistant/application/assistant-tools.ts#AssistantToolCatalog]
- **S46.R-25** The device location MUST come only from the send request, and its coordinates MUST NOT reach a provider request, the stored transcript, an event or a log line. [proof: S46 AS-13, S46 AS-56, S46 AS-57] [code: packages/backend/libs/domains/assistant/application/turn-runner.ts#TurnRunner]
- **S46.R-26** Parallel tool calls MUST run at the same time with a deadline of 5 seconds each, all results of a round MUST return in one message in call order, and a failed tool MUST give a generic error result. [proof: S46 AS-16, S46 AS-18] [code: packages/backend/libs/domains/assistant/application/turn-runner.ts#TurnRunner]
- **S46.R-27** The tool loop MUST be bounded to 5 model calls with tools, the last call MUST forbid tools, and a tool request there MUST end the turn with `error TOOL_LOOP_LIMIT`. [proof: S46 AS-17, S46 AS-21] [code: packages/backend/libs/domains/assistant/application/turn-runner.ts#MAX_ROUNDS]
- **S46.R-28** Text written by sellers MUST reach the model only as tool-result content and the frozen system prompt MUST label it as data. [proof: S46 AS-19] [code: packages/backend/libs/domains/assistant/application/assistant.prompt.ts#ASSISTANT_SYSTEM]
- **S46.R-29** Input MUST be moderated before any lock is taken and rejected with `422` `input_rejected` and a category, a card number or a secret MUST be category `sensitive_data`, and a failing moderator MUST give `503` `assistant_unavailable`. [proof: S46 AS-52, S46 AS-53, S46 AS-55] [code: packages/backend/libs/domains/assistant/infra/moderation.adapter.ts#AssistantModerationAdapter]
- **S46.R-30** Output MUST be moderated per chunk with the 256 characters before it, a flagged chunk MUST NOT be published, and the stream MUST end with `refusal` from `moderation`. [proof: S46 AS-54, S46 AS-55] [code: packages/backend/libs/domains/assistant/domain/output-window.ts#OutputWindow]
- **S46.R-31** Message text, answers, tool arguments and results, coordinates, tokens and the provider key MUST NOT appear in a prompt, event, metric label or log line. [proof: S46 AS-56, S46 AS-57, S46 AS-70] [code: packages/backend/libs/domains/assistant/application/turn-log.ts#logIds]
- **S46.R-32** The monthly allowance MUST come from the buyer's entitlement in billing, be counted per UTC month, be seeded from billing's exact usage when the counter is absent, and fail closed when unreadable. [proof: S46 AS-33, S46 AS-34] [code: packages/backend/libs/domains/assistant/application/allowance.service.ts#AllowanceService]
- **S46.R-33** An exhausted allowance MUST answer `429` `quota_exceeded` with `Retry-After` to the end of the month and with `used`, `limit` and `resetsAt`. [proof: S46 AS-32, S46 AS-34] [code: packages/backend/libs/domains/assistant/application/assistant-errors.ts#Domain_QuotaExceeded]
- **S46.R-34** Usage reads MUST return `used`, `limit` and `resetsAt` for the caller only, from the same counter and limit as admission. [proof: S46 AS-42] [code: packages/contracts/src/assistant/usage.ts#assistantUsageSchema]
- **S46.R-35** Each model call MUST be charged once, keyed by its call id, with input plus cache-write plus output plus one tenth of cache-read tokens rounded up, and an aborted call MUST be charged an estimate. [proof: S46 AS-35, S46 AS-62] [code: packages/backend/libs/domains/assistant/infra/redis-quota.counter.ts#RedisQuotaCounter]
- **S46.R-36** Sends MUST be limited to 20 per minute per user (fail closed), 3 concurrent replies per user, 1 reply per conversation, and the fleet-wide provider token budget (fail open). [proof: S46 AS-36, S46 AS-37, S46 AS-39, S46 AS-40] [code: packages/backend/libs/domains/assistant/rate-limit-policies.ts#assistantRatePolicies]
- **S46.R-37** A provider `Retry-After` MUST set a per-model cooldown shared by all instances, with 5 seconds when the provider gives none. [proof: S46 AS-38] [code: packages/backend/libs/domains/assistant/application/model-router.ts#ModelRouter]
- **S46.R-38** A [transient failure](../terms/transient-failure.md) of the primary model before the first token MUST be retried once on the fallback model, and after the first token or on a non-transient error it MUST NOT. [proof: S46 AS-43, S46 AS-44, S46 AS-45, S46 AS-48] [code: packages/backend/libs/domains/assistant/application/model-router.ts#ModelRouter]
- **S46.R-39** Each model MUST have a circuit breaker that opens after 5 consecutive transient failures, cools down for 30 seconds and admits one probe, and both breakers open MUST answer `503` at admission. [proof: S46 AS-46, S46 AS-47] [code: packages/backend/libs/common/resilience/circuit-breaker.ts#CircuitBreaker]
- **S46.R-40** Every outbound call MUST have a timeout, and the first-token (30 seconds), whole-call (120 seconds) and turn (240 seconds) deadlines MUST be enforced. [proof: S46 AS-49] [code: packages/backend/libs/domains/assistant/application/model-router.ts#ModelRouter]
- **S46.R-41** The provider adapter MUST retry only transient failures before the first token, at most twice, with exponential backoff and full jitter, honouring `Retry-After`, and only inside the adapter. [proof: S46 AS-50] [code: packages/backend/libs/infrastructure/llm/anthropic.provider.ts#AnthropicLlmProvider]
- **S46.R-42** A provider refusal MUST end the turn with `refusal` from `provider`, persist nothing, and be metered with its real usage. [proof: S46 AS-51] [code: packages/backend/libs/domains/assistant/application/turn-runner.ts#TurnRunner]
- **S46.R-43** A send MUST carry an `Idempotency-Key`; a finished replay MUST return the stored events with `Idempotent-Replay: true` and no new call, charge or turn; the same key in flight MUST be `409` `idempotency_in_flight`; a different body MUST be `422` `idempotency_key_reuse`. [proof: S46 AS-63, S46 AS-64, S46 AS-65, S46 AS-66] [code: packages/backend/libs/domains/assistant/domain/request-fingerprint.ts#requestFingerprint]
- **S46.R-44** Keys MUST be scoped per user and held for the replay window, and a send rejected before generating MUST release its key. [proof: S46 AS-67] [code: packages/backend/libs/domains/assistant/infra/redis-admission.adapter.ts#RedisAdmissionAdapter]
- **S46.R-45** Every model call, whether chat, summary, aborted, refused, failed or a fallback attempt, MUST append exactly one `llm.call_completed` v1 record through the outbox. [proof: S46 AS-43, S46 AS-68] [code: packages/backend/libs/domains/assistant/application/metering.service.ts#MeteringService]
- **S46.R-46** The event `llm.call_completed` v1 MUST parse with the billing fields `subjectId`, `metric`, `billableTokens` and `callId` present, and fields MUST only ever be added within version 1. [proof: S46 AS-73, S46 AS-69] [code: packages/contracts/src/assistant/llm-call-completed.ts#llmCallCompletedV1]
- **S46.R-47** The analytics consumer MUST keep one row per `eventId` and MUST dead-letter an invalid payload with its reason. [proof: S46 AS-69] [code: packages/backend/libs/domains/assistant/infra/llm-calls.projector.ts#LlmCallsProjector]
- **S46.R-48** The assistant MUST export the metrics `assistant_ttft_seconds`, `assistant_turn_duration_seconds`, `assistant_tokens_total`, `assistant_turns_total`, `assistant_fallbacks_total`, `assistant_aborts_total`, `assistant_active_streams` and `assistant_admission_rejected_total`, with no user or conversation id as a label. [proof: S46 AS-70] [code: packages/backend/libs/domains/assistant/application/assistant-metrics.ts#assistantTtft]
- **S46.R-49** A metering failure MUST NOT fail the turn, MUST be retried 3 times, and MUST be counted and logged with the call id, subject, billable tokens and cost. [proof: S46 AS-71] [code: packages/backend/libs/infrastructure/llm/llm-call-recorder.ts#LlmCallRecorder]
- **S46.R-50** Startup MUST fail, naming the key, for a real provider without a key, the scripted provider in production, a model without a price, a negative or non-integer limit or timeout, an equal fallback when a distinct one is required, or a heartbeat above 25 seconds. [proof: S46 AS-74] [code: packages/backend/libs/infrastructure/llm/llm-config.ts#assertLlmConfig]
- **S46.R-51** On shutdown readiness MUST fail at once, new sends MUST be refused with `503`, running replies MUST drain for 25 seconds, then end with `error SHUTTING_DOWN` and release their locks and slots. [proof: S46 AS-75] [code: packages/backend/libs/domains/assistant/application/generation.service.ts#GenerationService]
- **S46.R-52** The model provider port MUST live in an infrastructure library that imports no domain code and no assistant concept, and a caller with `maxRetries: 0` MUST get exactly one attempt and a typed `LlmUnavailableError` or `LlmRejectedError`. [proof: S46 AS-77] [code: packages/backend/libs/infrastructure/llm/llm-provider.ts#LlmUnavailableError]
- **S46.R-53** The assistant MUST read other domains only through their exported services and MUST reach billing only through events. [proof: S46 AS-76] [code: packages/backend/libs/domains/assistant/assistant.module.ts#AssistantModule]

## Behaviors
- **S46.B-01** Given a shopper with an empty conversation, when they send "hi" and the model answers in three pieces, then the stream carries `meta`, the text, then `done`, and the history holds both messages. [proof: S46 AS-01]
- **S46.B-02** Given a product description that tells the assistant to place an order, when the assistant reads it, then the text arrives only inside a tool result and no order is placed. [proof: S46 AS-19]
- **S46.B-03** Given a shopper who shares a location and asks for a phone nearby, when the tool runs, then the pickup search uses the coordinates and they appear in no provider request or log. [proof: S46 AS-13]
- **S46.B-04** Given a phone that loses its connection after twelve events, when it reconnects with the id of the twelfth, then the thirteenth event comes first and none repeats. [proof: S46 AS-22]
- **S46.B-05** Given a shopper who closes the tab mid-answer, when nobody returns within the grace period, then the provider call stops and the conversation accepts a new message. [proof: S46 AS-26]
- **S46.B-06** Given a shopper whose allowance is used up, when they send a message, then the answer is `429` with the reset time and the model is not called. [proof: S46 AS-32]
- **S46.B-07** Given a primary model that is overloaded before its first word, when a shopper sends a message, then the fallback model answers and the shopper sees no error. [proof: S46 AS-43]
- **S46.B-08** Given a message that contains a card number, when it is sent, then it is rejected as `sensitive_data` and nothing is stored or logged. [proof: S46 AS-53]
- **S46.B-09** Given a client that retries a send with the same key after it finished, when the retry arrives, then the stored events are replayed and the shopper pays once. [proof: S46 AS-63]
- **S46.B-10** Given a turn with two tool rounds and an answer, when it ends, then three `llm.call_completed` records exist and the month counter equals their billable tokens. [proof: S46 AS-68]

## Lifecycles
A generation is running, then ends in exactly one of done, refusal or error, and a terminal state never changes. The error codes are `CANCELLED`, `PROVIDER_UNAVAILABLE`, `TURN_TIMEOUT`, `GENERATION_LOST`, `MODERATION_UNAVAILABLE`, `SHUTTING_DOWN`, `TOOL_LOOP_LIMIT` and `INTERNAL`. A circuit breaker is closed, open or half-open.

## Owns
- Conversation and message storage keyed by user and conversation (the transcript store), and the fast-store keys of reply locks, replay buffers, month counters, idempotency records, cooldowns and liveness.
- Rate-limit policies `llm.messages` and `llm.provider.tpm`; the `assistant_*` metrics.
- The event `llm.call_completed` v1 and the infrastructure library `@app/infrastructure/llm`.

## Decisions
- The reply is a buffer that one or more viewers read, so a dropped connection never loses text and an unwatched reply can be aborted.
- Only a turn that ends `done` is stored, so a transcript never holds a dangling tool request.
- Billing learns usage only from the event, never from a direct call, so a retried delivery changes nothing.
- The model is never switched inside a conversation, because that would break the prompt cache and the thinking blocks.
- A limiter store that is down answers `503 rate_limiter_unavailable` for the send rate (the S50 code), not `assistant_unavailable`.
- Where the older design note and the constitution disagree on a status code or a boundary, the constitution wins.

## Known gaps
- The success criteria for first-token latency (SC-001), abort timing (SC-003), billing reconciliation (SC-007) and 5,000 concurrent streams (SC-010) have no automated proof and are listed in `specs/UNVERIFIED.md`.
- The first-token deadline of a call counts the first streamed text; a call that thinks or writes a tool request for longer than 30 seconds before any text is treated as a transient failure.
- The assistant sheet and its resume behavior belong to W05, and "ask this product" and the help center belong to S47.
