# Gaps: S46 — current code versus `spec.md`

The implementation agent's to-do list. Paths are under `packages/backend/libs/domains/assistant/` unless stated; line numbers are from the code read on 2026-10-06. `pnpm check:table-ownership` needs approval in this session and was **not run**: the ownership findings below come from code search (`@app/domains/*` imports, `@InjectModel`, raw SQL), and must be re-checked against the live `MODEL` and `SQL` rows of the report before closing (see "Table-ownership findings"). Rows marked **(S47)** belong to the knowledge half of the domain and are listed only so S46's changes do not break them.

## What the code gets wrong or lacks

### Streaming, resume, abort

| # | Gap | Where | Spec |
|---|---|---|---|
| G1 | Malformed `Last-Event-ID` is treated as "from the start" | `api/assistant.controller.ts:87` | AS-24, FR-004 |
| G2 | Stream/cancel of another user's generation returns `403`; ownership is read then compared, not part of the lookup key | `api/assistant.controller.ts:100-105`, `infra/generation-buffer.ts:55-58` | AS-05 |
| G3 | Cancel of a finished generation returns `202` and does nothing | `api/assistant.controller.ts:92-98`, `application/assistant.service.ts:134-139` | AS-29 |
| G4 | No generator liveness: a crashed instance leaves viewers waiting forever and the conversation locked up to 5 min | `application/assistant.service.ts:25,118`, `infra/generation-buffer.ts` | AS-30 |
| G5 | Terminal event can be lost silently (`.catch` only logs) and the buffer `close` runs even then | `application/assistant.service.ts:201-202` | FR-001, AS-30 |
| G6 | Replay window 10 min (`RETAIN_MS`); spec 15 min, tied to the idempotency window | `infra/generation-buffer.ts:21` | FR-003 |
| G7 | Heartbeat is a hard-coded 15 s and not configurable (tests cannot force it); no validation against proxy idle limits | `api/assistant-stream.ts:5` | AS-02, AS-74 |
| G8 | `done` exposes `costMicros` and cache counters; no `allowance` | `application/assistant.service.ts:145,189` | AS-01, AS-02 |
| G9 | Remote-viewer polling is fixed at 300 ms and each viewer touches Redis per poll; no test with a second instance | `api/assistant-stream.ts:6,66-72` | AS-27 |
| G10 | No graceful-shutdown handling for running generations | `application/assistant.service.ts` (none) | AS-75 |
| G11 | The `generate` loop runs as a detached promise started with `void` and has no turn deadline | `application/assistant.service.ts:130,141-204` | AS-49 |

### Persistence and context

| # | Gap | Where | Spec |
|---|---|---|---|
| G12 | The user message is stored before the model runs, tool rounds as they happen; a refusal, cancel or failure leaves an unanswered user message or a round without its answer | `application/assistant.service.ts:153,176,184` | AS-61, FR-012 |
| G13 | Conversation size check reads `count(*)` over the partition on every send | `infra/conversation.store.ts:75-78`, `application/assistant.service.ts:112` | AS-41 (counter on the conversation row) |
| G14 | List has no cursor, no `limit` param, no `messageCount`; no delete | `infra/conversation.store.ts:54-60`, `api/assistant.controller.ts:48-51` | AS-07, AS-09 |
| G15 | Compaction marker updated with a plain `UPDATE` (no "only forward" guard) | `infra/conversation.store.ts:96-101` | AS-59 |
| G16 | Compaction failure (summary model down) is not handled: the error surfaces as `INTERNAL` | `application/assistant.service.ts:266-268` | AS-60 |
| G17 | `history` returns every stored message with no shape contract in `packages/contracts` | `application/assistant.service.ts:93-108` | AS-08, FR-043 |
| G18 | No `packages/contracts` schemas exist for any assistant request, response or stream event | `packages/contracts` (none) | FR-043: `assistantConversationSchema`, `assistantConversationListSchema`, `assistantHistorySchema`, `assistantSendMessageRequestSchema`, `assistantStreamEventSchema`, `assistantUsageSchema`, `llmCallCompletedV1` |

### Admission, quotas, limits

| # | Gap | Where | Spec |
|---|---|---|---|
| G19 | `POST …/messages` has no `Idempotency-Key`, so a retried send is a second paid turn | `api/assistant.controller.ts:70-80` | AS-63–AS-67 |
| G20 | Admission order is ad hoc (size → quota → lock → budget); rate limit applies before ownership; the checks do not release what earlier ones took in every path | `application/assistant.service.ts:110-132` | AS-06 |
| G21 | Limit falls back to a local default; counter is not seeded from billing; billing failure is not fail-closed | `application/assistant-quota.service.ts:9,33-36` | AS-33 |
| G22 | `charge` is not idempotent by call id; its failure is only logged; aborted calls are not charged | `application/assistant-quota.service.ts:58-62`, `application/assistant.service.ts:293` | AS-35 |
| G23 | Month key and `resetsAt` use `new Date()` directly (not an injected clock) | `application/assistant-quota.service.ts:11,46-47` | AS-34, I.3 |
| G24 | No per-user concurrent reply cap | `application/assistant.service.ts` (none) | AS-39 |
| G25 | Provider budget cost uses `COMPACT_AT_TOKENS / 4` as a constant guess; its limiter failure mode is not logged or counted | `application/assistant.service.ts:123`, `application/assistant-quota.service.ts:52-56` | AS-37 |
| G26 | A lone `lat` or `lng` is silently dropped; `lat`/`lng` pass `@IsLatitude`/`@IsLongitude` but the "both or neither" rule does not exist | `api/assistant.controller.ts:75` | AS-03 |
| G27 | `GET /assistant/usage` returns `{used, allowance}` with no `resetsAt`; no `503` path | `application/assistant-quota.service.ts:38-41` | AS-42 |
| G28 | Per-turn conversation lock key uses a fixed 5-minute TTL regardless of the turn deadline | `application/assistant.service.ts:25,118` | AS-49 |

### Tools and safety

| # | Gap | Where | Spec |
|---|---|---|---|
| G29 | Tools call catalog internals `ProductService.search/findById` and fulfilment's `AvailabilityIndex.searchNear` | `application/assistant-tools.ts:4-5,101,108,116` | AS-11–AS-13, FR-018 |
| G30 | `product_details` returns any product by id, including archived and sandbox ones, and `inStock`/`price` field names are the old shape | `application/assistant-tools.ts:106-112` | AS-12 |
| G31 | Tool calls have no deadline | `application/assistant-tools.ts:95-127` | AS-18 |
| G32 | Unknown tool / invalid input echoes the raw model input back (`INVALID_INPUT: JSON.stringify(input)`), which can carry seller text | `application/assistant-tools.ts:131` | AS-15 |
| G33 | Round-limit misbehaviour (tool request on the last round) throws a plain `Error` that ends as `INTERNAL` | `application/assistant.service.ts:158` | AS-17 (`TOOL_LOOP_LIMIT`) |
| G34 | `pause_turn` is persisted but does not count toward the round bound distinctly | `application/assistant.service.ts:185-188` | AS-21 |
| G35 | No moderation (input, output, sensitive data) and no `input_rejected` error | `application/assistant.service.ts` (none) | AS-52–AS-55 |
| G36 | No provider end-user identifier; no scan proving prompts hold no PII | `infra/llm/anthropic.provider.ts:64-90` | AS-56 |
| G37 | Logging: `logger.error` prints the stack of any failure; tool failures log `error.message` that can contain upstream text | `application/assistant.service.ts:195`, `application/assistant-tools.ts:124` | AS-57 |

### Reliability

| # | Gap | Where | Spec |
|---|---|---|---|
| G38 | No circuit breaker | `application/assistant.service.ts:207-239` | AS-46, AS-47 |
| G39 | Fallback only on `LlmUnavailableError` and `streamed` is per call but not reported as a record; the failed attempt is not metered | `application/assistant.service.ts:217-238` | AS-43 |
| G40 | Provider `Retry-After` is not honoured fleet-wide; 429 without header unhandled | `infra/llm/anthropic.provider.ts:104-110` | AS-38 |
| G41 | No distinction between transient and non-transient provider errors: a 400/401 rethrows the raw SDK error to a generic `INTERNAL`; no `LlmRejectedError`; no breaker accounting | `infra/llm/anthropic.provider.ts:104-116` | AS-48 |
| G42 | Only the 120 s SDK timeout exists; no first-token, tool or turn deadline; SDK retries `maxRetries: 2` are not configurable per request (S04 needs 0) | `infra/llm/anthropic.provider.ts:7,33`, `infra/llm/llm-provider.ts:6-18` | AS-49, AS-50, AS-77 |
| G43 | A missing API key silently selects the scripted provider, also in production | `infra/llm/llm.module.ts:14-15` | AS-74 |
| G44 | Unknown model in the price table is priced as the most expensive known model | `infra/llm/pricing.ts:11-12` | AS-62, AS-74 |
| G45 | Model ids are read with `?? 'claude-opus-5-5'` defaults, not validated at startup | `application/assistant.service.ts:74-77` | AS-74 |
| G46 | Refusal path stores nothing but does not release/charge consistently with other outcomes and does not carry `source` | `application/assistant.service.ts:163-167` | AS-51 |

### Metering

| # | Gap | Where | Spec |
|---|---|---|---|
| G47 | Metering calls billing's `UsageService.record` directly (fire-and-forget) and sends Kafka directly (dual write) | `infra/llm/llm-meter.ts:3,48-56` | AS-68, FR-035, D-14 |
| G48 | `callId` is the message id for every call of a turn; summary shares it | `infra/llm/llm-meter.ts:35-40`, `application/assistant.service.ts:292` | AS-68 |
| G49 | Event lacks `subjectId`, `metric`, `billableTokens`, `callId`, `outcome`, `usageEstimated`; `eventId` is not deterministic per call | `application/events/assistant-events.ts:5-22`, `infra/llm/llm-meter.ts:35` | AS-68, AS-73 (S18 contract) |
| G50 | `Math.max(1, tokens)` bills a unit for a zero-token call | `infra/llm/llm-meter.ts:54` | AS-68 |
| G51 | Failed, aborted and refused calls are not recorded (the meter runs only after a successful `streamTurn`) | `application/assistant.service.ts:229` | AS-68, AS-35 |
| G52 | `llm-calls` projector has no invalid-payload handling (silently `.filter`s) and no DLQ test | `infra/llm-calls.projector.ts:23-24` | AS-69 |
| G53 | No metrics beyond logs (TTFT, tokens, fallbacks, aborts, active streams, rejections) | `application/assistant.service.ts` (none) | AS-70 |
| G54 | Metering failure only logs a warning; no retry, no counter, no re-creation fields | `infra/llm/llm-meter.ts:55` | AS-71 |

### Layering and boundaries

| # | Gap | Where | Spec |
|---|---|---|---|
| G55 | `application/` imports `infra/` classes (`ConversationStore`, `GenerationBuffer`, `LlmMeter`, `pricing`, `llm-provider`) and the Redis service directly; `api/` imports `GenerationBuffer` | `application/assistant.service.ts:5-15`, `api/assistant.controller.ts:9` | I.2, AS-76 (D-6) |
| G56 | `domain/` has no assistant logic at all (state machine of a generation, admission order, fingerprint, billable tokens, sensitive-data rules, coalescer are in `application/` or `infra/`) | `domain/` holds only `chunker.ts`, `rrf.ts` | AS-10, AS-53, AS-62, AS-65 |
| G57 | The barrel exports provider internals, `LlmMeter`, `Retriever`, `LlmCallsProjector`, `ScriptedLlmProvider`, models of the knowledge half | `index.ts:8-16` | AS-76, X.4 (D-8) |
| G58 | Existing e2e covers only the SD-42 rows (14 tests); no idempotency, moderation, breaker, timeouts, metering, shutdown, cross-user stream/cancel `404`, validation classes, `401` | `assistant.e2e-spec.ts:80-321` | `test-plan.md` |
| G59 | Web: `useAssistantChat` and `lib/api/assistant.ts` send no `Idempotency-Key`, parse no contract schema, and know none of the new codes | `packages/web/hooks/use-assistant-chat.ts`, `packages/web/lib/api/assistant.ts` | W05 contract |

## Open debt-register rows naming `assistant` or S46

| Row | What it says for this domain | Replaced by (IX.7) | Done when |
|---|---|---|---|
| **D-6** (I.2, open) | `api/` and `application/` import `infra/` directly | Ports and tokens in `domain/` (`ConversationRepository`, `GenerationBuffer`, `ModerationPort`, `QuotaCounter`, `Clock`), adapters in `infra/` (G55) | no `infra/` path in imports of `api/` or `application/`; `pnpm check:boundaries` clean for this lib |
| **D-7** (IX.4, open) | Other domains' `*Model` exports | The assistant itself imports no foreign model today; it **exports** none except the knowledge-half models (S47). Tools use R1 services only | barrel exports no model from this domain's S46 half |
| **D-8** (X.4, open) | Barrel exports projector and provider internals | `AssistantProjectorModule` for `apps/projector`; provider exports move to `@app/infrastructure/llm` (G57) | `index.ts` exports modules, DTO types, event contracts only |
| **D-12** (IX.4, open) | Raw SQL on another domain's tables | S46 half: none in code. Tools reach catalog and fulfilment through R1 (G29). **(S47)**: `SELECT "shopId" FROM "Product"` in `application/knowledge.service.ts:246` and `api/knowledge.controller.ts:81` → S05 R1 `getProductsByIds` (S05's gaps already list it) | check reports zero `SQL` rows for this domain |
| **D-14** (X.3, X.7, open) | LLM port and adapters in `assistant/infra/llm` used by seller-onboarding and the Lambda; `llm-meter` calls billing directly | **S46 meters by publishing `llm.call_completed` through the outbox only** (R3: S18 consumes it into its own store), then **moves the port, adapters, pricing, scripted adapter and recorder to `libs/infrastructure/llm`**; S04 switches its import (G47–G49, G42) | `UsageService` gone from `assistant.module.ts:10,32`, `knowledge.module.ts:39`, `onboarding.module.ts:34`; `libs/infrastructure/llm` has no domain imports |

Rows that do not name this domain (D-1 … D-5, D-9 … D-11, D-13, D-15 … D-17) are not S46's.

## Table-ownership findings (cross-domain SQL and model access, D-7 / D-12)

`pnpm --dir packages/backend check:table-ownership` could not be run here (requires approval). Findings from code search, to confirm against the live report:

| Kind | Where | Foreign object | Replaced by |
|---|---|---|---|
| IMPORT of a domain-internal provider | `application/assistant-tools.ts:4` | catalog `ProductService` (via `@app/domains/catalog`, `ProductModule` imported at `assistant.module.ts:8,23`) | **R1**: S32 `ProductSearchService.search`, S05 `ProductQueryService.getProductsByIds` |
| IMPORT of a domain-internal class | `application/assistant-tools.ts:5` | fulfilment `AvailabilityIndex` (`PickupModule` at `assistant.module.ts:9,23`) | **R1**: S19 `PickupNearMeService.searchNear` (**S19 must add it**, see CONTRACT in `questions.md`) |
| Re-provided foreign service | `assistant.module.ts:10,32`; `knowledge.module.ts:10,39` | billing `UsageService` (constructed again with the assistant's wiring) | **R3**: no direct call; S18 consumes `llm.call_completed` |
| Re-provided foreign service | `assistant.module.ts:10,31`; `application/assistant-quota.service.ts:4` | billing `EntitlementsService` provided in the assistant's own module instead of imported | **R1**: import `BillingModule` and inject the exported `EntitlementsService` (S18) |
| Raw SQL on a foreign table **(S47)** | `application/knowledge.service.ts:246`, `api/knowledge.controller.ts:81` | catalog `Product` (`SELECT "shopId" FROM "Product"`) | **R1**: S05 `getProductsByIds` |
| Foreign model in a spec | `knowledge.e2e-spec.ts:17,26` | tenancy `ShopModel`, `ShopMembershipModel` | test seeds (allowed in test code, IX.6); move to the shared seed helpers |
| Own tables, raw SQL (allowed) | `application/knowledge.service.ts`, `infra/retriever.ts` | `KnowledgeDocument`, `KnowledgeChunk` | stays; `api/knowledge.controller.ts` and `application/knowledge.service.ts` issue SQL from `api/`/`application/` (I.2, D-6; S47) |

The assistant's own stores are not Postgres tables: conversations (Scylla, `assistant_conversations_by_user`, `assistant_messages_by_conversation`), generation buffer and counters (Redis keys under `assistant:`), analytics (ClickHouse `llm_requests`). They are owned by this domain and have no foreign access.

## Order of work (suggested)

1. Contracts: `packages/contracts` schemas (G18) and the S19 `PickupNearMeService` ask (coordinate with S19/S05/S32/S18 agents).
2. Move provider port, adapters, scripted adapter, pricing and add `LlmCallRecorder` + outbox event + startup validation to `libs/infrastructure/llm` (G42–G45, G47–G51, AS-50, AS-72, AS-74, AS-77); update S04's import.
3. Domain layer: ports, generation state machine, admission order, fingerprint, sensitive-data rules, coalescer, billable tokens (G55–G56); unit specs.
4. Turn pipeline: moderation, idempotency, atomic persistence, concurrent-reply cap, breaker, deadlines, liveness, shutdown (G1–G12, G19–G28, G35, G38–G41, G46).
5. Tools through R1 services, privacy and injection tests (G29–G34, G36–G37).
6. Projector DLQ and metrics (G52–G54); update the web client (G59) and rewrite `assistant.e2e-spec.ts` into the spec files of `test-plan.md` (G58).
7. Close D-6, D-8, D-14 in `docs/architecture/debt-register.md` with the actual commit; leave D-7/D-12 notes for S47.
