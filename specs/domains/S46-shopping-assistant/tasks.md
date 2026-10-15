# Tasks: S46 — Streamed Shopping Assistant (domain `assistant`, shopping half)

**Input**: `plan.md`, `spec.md`, `test-plan.md`, `gaps.md` (G1–G59, D-6/D-8/D-14), `data-model.md`, `contracts/*`, `research.md`, `quickstart.md`, `questions.md` (defaults accepted).
**Tests**: required (test-plan.md, constitution VII). Each scenario's failing test task comes **before** its code task.
**Format**: `- [ ] T### [P?] [US?] Description with file path`. `[P]` = different files, no dependency on an unfinished task.

## Path conventions

- `BE` = `packages/backend`; `ASSIST` = `packages/backend/libs/domains/assistant`; `LLM` = `packages/backend/libs/infrastructure/llm`; `CONTRACTS` = `packages/contracts/src/assistant`; `WEB` = `packages/web`.
- Backend specs run from `packages/backend` with `/opt/sdd/repo/scripts/sdd/test-spec.sh <file>`. Same test failing after 5 fixes → write the blocker into `questions.md` and stop.
- Rules that apply to every task: no `*.reviewed.json`; no git checkout/restore/reset/stash/clean (undo by hand); no new direct `sequelize.transaction` (the shopping half opens none); no "A or B" assertions (L-003); each test creates its own users/conversations/products (L-005/L-006); forced-failure tests restore the injector in `afterEach` (L-013); scenario→test mapping AS-01…AS-77 stays 1:1 by `AS-nn` in test titles (L-017).

---

## Phase 1: Setup (living spec, contracts, scaffolding)

- [X] T001 Write the living page `docs/spec/capabilities/S46-shopping-assistant.md` first (rule 0): today's behavior, then the rules of spec.md (AS-01…AS-77, FR-001…FR-043); every `[proof: ...]`/`[code: ...]` must be true; run `python3 scripts/livespec/check.py` and fix findings. Do not create any `*.reviewed.json`.
- [X] T002 [P] Create Zod schemas in `CONTRACTS/`: `conversation.ts` (title trimmed 1–120, default "New chat"), `history.ts`, `send-message.ts` (`text` 1–4000 chars after trim; `lat` −90…90 and `lng` −180…180, both or neither; strict, no unknown fields), `stream-events.ts` (meta/text/tool/done/refusal/error; `done` has `allowance`, no cost fields), `usage.ts` (`used`, `limit`, `resetsAt`), `llm-call-completed.ts` (v1, optional `scopeId`/`outcome` tolerated); re-export from `CONTRACTS/index.ts` and the package index (G17, G18, FR-043).
- [X] T003 [P] Add contract unit tests next to the schemas in `CONTRACTS/*.spec.ts` (valid/invalid tables per field incl. lone `lat`, 4001-char text, unknown field, cursor, `Idempotency-Key` `[A-Za-z0-9_-]{1,128}`, list `limit` 1–50 default 20); write before T002 code is finalized.
- [X] T004 Create empty-but-compiling folders and barrels: `ASSIST/domain/assistant-ports.ts` (tokens + interfaces `ConversationRepository`, `GenerationStore`, `ModerationPort`, `QuotaCounter`, `Clock`, `AdmissionStore`, `ToolCatalog`), `ASSIST/assistant-projector.module.ts` skeleton, `LLM/index.ts` skeleton (G55, G56, D-6).

---

## Phase 2: Foundational (blocks every story)

### 2a. Shared lib `@app/infrastructure/llm` (Phase A; G42–G45, G47–G51, AS-50, AS-62, AS-72, AS-74, AS-77, D-14)

- [X] T005 [P] Write failing unit specs in `LLM/`: `billable-tokens.spec.ts` (AS-62 formula `input + cacheWrite + output + ceil(cacheRead/10)`, `estimateTokens = ceil(chars/4)`, `fast-check` monotonic/non-negative/integer), `pricing.spec.ts` (AS-72 per-model usage table → integer micros; AS-74 unknown model → error), `backoff.spec.ts` (AS-50 full-jitter bounds table).
- [X] T006 [P] Write failing `LLM/llm-provider.e2e-spec.ts` (ADAPTER, `describe('LLM provider port and Anthropic adapter')`): AS-50 "retries 429/5xx/reset before first token ≤ 2 with Retry-After; never 4xx; never after first token; maxRetries 0 → one attempt" against a local HTTP double; AS-77 "complete() with maxRetries 0, timeout, output schema and document block: one attempt, typed errors, one extraction record".
- [X] T007 Move `ASSIST/infra/llm/*` to `LLM/` (`llm-provider.ts` port + `LlmUnavailableError`/`LlmRejectedError`, `anthropic.provider.ts`, `scripted.provider.ts`, `pricing.ts`, `llm.module.ts`); add `billable-tokens.ts`, `backoff.ts`, per-request `maxRetries`/`timeoutMs`/first-token deadline (G42), 4xx → `LlmRejectedError` non-transient (G41), 429 without header handled with default backoff (G40); contract in `contracts/llm-port.md`. Makes T005/T006 pass.
- [X] T008 Implement `LLM/llm-config.ts`: parse `anthropic_api_key` and `assistant_model` (and fallback/summary model ids, timeouts, heartbeat) from the environment; scripted provider only when explicitly configured outside production; missing key in production fails startup naming the key (G43, G45, AS-74, S47 follow-up). Remove `?? 'claude-opus-5-5'` defaults. Unknown model in price table throws (G44).
- [X] T009 Implement `LLM/llm-call-recorder.ts` (`LlmCallRecorder`): appends outbox event `llm.call_completed` v1 via `OutboxService` (`append` in caller transaction else `appendStandalone`), `callId = "<messageId>:<n>"` (summary `"<messageId>:0"`), `eventId` = UUIDv5(callId), fields `subjectId, metric, billableTokens, outcome, usageEstimated, purpose`, no `Math.max(1, …)` (G48–G51), retry ×3 then counter+log with `callId` (G54); per `contracts/llm-call-completed-v1.md`. Delete `llm-meter.ts` direct `UsageService`/Kafka calls (G47, D-14).
- [X] T010 Switch consumers to the lib: S47 adapters `ASSIST/infra/call-recorder.adapter.ts` (→ `LlmCallRecorder`), `answer-model.adapter.ts` (→ `LlmProvider`), `moderator.adapter.ts` (→ moderation backend) — one file each, imports/delegation only; `packages/backend/libs/domains/seller-onboarding/**` imports (`LLM_PROVIDER`, `LlmUnavailableError`, `LlmRejectedError`, `LlmCallRecorder` from `@app/infrastructure/llm`, S04 import paths only); keep `ASSIST/index.ts` aliases thin until T117. Export the three S47 ports `AnswerModel`, `CallRecorder`, `Moderator`.
- [X] T011 [P] ClickHouse migration for `llm_requests`: additive columns `call_id, subject_id, metric, billable_tokens, outcome, usage_estimated, purpose`, dedupe by `event_id` kept (data-model.md); place with the existing ClickHouse migrations (`grep -rn llm_requests`).
- [X] T012 Run `test-spec.sh libs/infrastructure/llm`, then S47 (`libs/domains/assistant/knowledge`) and `libs/domains/seller-onboarding` suites; all stay green (test-plan row 14).
- [ ] T013 Boot proof (L-004, L-015, L-018): start `apps/core`, `apps/projector`, `apps/sse-gateway` each on its own and call `GET /api/assistant/usage` (401 without session); fix missing imports. Record in `questions.md` only if blocked.

### 2b. Shared breaker and domain primitives

- [X] T014 [P] Add failing rows to `BE/libs/common/resilience/circuit-breaker.spec.ts` (path: find with `grep -rln "class CircuitBreaker"`): `consecutiveFailures` mode state table (`it.each`; success resets count; open → half-open → close/reopen) + `fast-check` "never two concurrent half-open probes" (AS-46 unit).
- [X] T015 Add additive `consecutiveFailures` option to `CircuitBreaker` in `BE/libs/common/resilience/circuit-breaker.ts`, default behavior unchanged (R-4; Complexity Tracking). No private breaker anywhere (S13/S54 follow-up).
- [X] T016 [P] Write failing domain unit specs under `ASSIST/domain/`: `generation-state.spec.ts` (`running → done|refusal|error`, terminal final, `error.code` set from data-model.md), `request-fingerprint.spec.ts` (AS-65: whitespace, field order, number format), `stream-id.spec.ts` (AS-22/AS-24: `compareStreamIds` numeric not lexical; id format table), `month.spec.ts` (AS-34: key + `resetsAt` incl. year end, leap day), `text-coalescer.spec.ts` (AS-10: fake timers, 400 deltas → ≤ 1 event per 40 ms / 256 chars, order kept, flush before terminal), `sensitive-data.spec.ts` (AS-53: 30 positive / 30 negative + `fast-check` Luhn), `output-window.spec.ts` (AS-54: 256-char window), `compaction.spec.ts` (AS-59 threshold table, count failure falls back to estimate), `admission-cost.spec.ts` (AS-37: `ceil(chars(system+tools+text)/4) + 15_000 + 2_000` capped at 2,000,000).
- [X] T017 Implement the pure `ASSIST/domain/` modules to pass T016: `generation-state.ts`, `request-fingerprint.ts`, `stream-id.ts`, `month.ts` (injected clock, UTC; G23), `text-coalescer.ts`, `sensitive-data.ts` (reuse S47's rule-based function), `output-window.ts`, `compaction.ts`, `admission.ts` (AS-06 order + weighted cost), `conversation-cursor.ts`; no framework imports; time only via the `Clock` port (G56). (Specs named `application/*.spec.ts` / `infra/*.spec.ts` in test-plan.md live next to the module in `domain/`.)
- [ ] T018 [P] Scylla migration (idempotent file in the existing Cassandra migrations folder, `grep -rn assistant_conversations_by_user`): `ALTER TABLE assistant_conversations_by_user ADD message_count int` (nullable; lazy backfill by `count(*)` then LWT set on first send); messages table partition `(user_id, conversation_id)`; columns `turn_id timeuuid`, `visible_text text`, `tool_names list<text>`; conversation `compacted_up_to timeuuid` null (data-model.md).
- [ ] T019 Implement infra adapters behind the ports (replacing the files named in plan.md): `ASSIST/infra/redis-generation.store.ts` (replaces `generation-buffer.ts`; hash-tagged keys `assistant:gen:{u:m}:*`, 15-min replay window, Lua terminal-once, owner is part of the key — G2, G6), `redis-admission.adapter.ts` (lock/slot/quota/idempotency/cooldown keys per data-model.md), `scylla-conversation.repository.ts` (replaces `conversation.store.ts`; `(user_id, conversation_id)` in every lookup; one same-partition batch), `moderation.adapter.ts`. Bind tokens in `ASSIST/assistant.module.ts`; import `BillingModule` for `EntitlementsService` instead of re-providing it; remove `ProductModule`/`PickupModule` re-provisioning later (T062).
- [ ] T020 [P] Add rate-limit policies in `ASSIST/rate-limit-policies.ts` with `definePolicies` + `forFeature`: keep `llm.messages` (20/min) and `llm.provider.tpm`; per `contracts/config-and-policies.md`; add `RateLimit`/`RateLimit-Policy` headers, `503 rate_limiter_unavailable`, `422 rate_limit_cost_exceeded` handling (S50 follow-up).

**Checkpoint**: lib green, domain unit specs green, `apps/*` boot, S47/S04 suites green.

---

## Phase 3: US1 — A shopper asks and watches the answer stream in (P1) 🎯 MVP

**Goal**: ordered stream with atomic persistence, validation, auth, isolation, conversations CRUD.
**Independent test**: `test-spec.sh assistant-turn.e2e-spec.ts` (AS-01…09 portion) + WEB journey.

- [ ] T021 [US1] Create `ASSIST/assistant-turn.e2e-spec.ts` (`describe('Shopping assistant: turns, conversations, idempotency')`) with failing tests: AS-01 "streams meta → text… → done in order and persists the turn"; AS-02 "headers, retry hint, heartbeat, strictly increasing ids, no cost in done" (configurable heartbeat); AS-03 `it.each` invalid classes incl. lone `lat`/`lng`, no side effect (G26); AS-04 `it.each` 401 over 8 routes; AS-05 foreign id → `404` for conversation, history, delete, stream, cancel; AS-07 create/list with keyset cursor + `limit` + `messageCount` (G14); AS-08 history hides thinking/context/tool output; AS-09 delete own, `409` while generating, `404` foreign.
- [ ] T022 [US1] Implement `ASSIST/application/conversation.service.ts` (create/list/history/delete with principal in every key; cursor; `messageCount`; delete refused while generating) and `ASSIST/api/assistant-dto.ts` using `CONTRACTS` schemas, `Firewall()`, problem filter (RFC 9457 + stable `code`); `400 invalid_cursor` (G2, G14, G17, G26).
- [ ] T023 [US1] Implement `ASSIST/application/assistant-turn.service.ts` + `turn-runner.ts` (model/tool loop, generation state machine, text coalescer, publishing events, `done` carries `allowance`, no cost/cache counters — G8) and `ASSIST/api/assistant.controller.ts` (8 routes per `contracts/http-api.md`) + `assistant-stream.ts` viewer loop only (configurable heartbeat ≤ 25 s — G7). Detached `void` generator replaced by a tracked run with turn deadline (G11).
- [ ] T024 [US1] Remove `ASSIST/application/assistant.service.ts` logic into the new services as they land; no `infra/` import from `api/` or `application/` (G55, D-6). Run `test-spec.sh assistant-turn.e2e-spec.ts -t "AS-0"`.
- [ ] T025 [P] [US1] Unit spec `ASSIST/domain/text-coalescer.spec.ts` already covers AS-10 (T016); confirm it is wired in the turn runner (coalesce ≤ 1 event per 40 ms / 256 chars, flush before terminal) and that AS-01 asserts the coalesced shape.
- [ ] T026 [US1] Web client (G59): `WEB/lib/api/assistant.ts` and `WEB/hooks/use-assistant-chat.ts` parse `CONTRACTS` schemas, send `Idempotency-Key` per message (reused on retry), handle `input_rejected`, `too_many_active_turns`, `assistant_unavailable`, `idempotency_in_flight`, `quota_exceeded` (`resetsAt`), `invalid_last_event_id`, `refusal {source:"moderation"}` replaces shown text, resume with `Last-Event-ID`, `RateLimit` headers; conversation created once per sheet open, `409` = open existing (L-010).
- [ ] T027 [US1] Create `WEB/tests/assistant.spec.ts` (`describe('Shopping assistant sheet')`, Playwright, isolated user per test, runner timeouts, no fixed sleeps — L-006/L-007): journey "ask 'find me a phone', answer streams in, tool chip shows, appears in history" (AS-01, AS-11). Write before T026 behavior is relied upon; run once on an empty stack at the end.

**Checkpoint**: US1 independently green.

---

## Phase 4: US2 — Tools: look up, only look (P1)

**Goal**: three read-only tools via R1 services, bounded loop, injection-safe.
**Independent test**: `test-spec.sh assistant-tools.e2e-spec.ts`.

- [ ] T028 [US2] Create `ASSIST/assistant-tools.e2e-spec.ts` (`describe('Shopping assistant: read-only tools')`) with failing tests: AS-11 search via `ProductSearchService` trimmed hits (price filter works on `priceMinor`); AS-12 `product_details` hides archived/sandbox/unknown identically; AS-13 pickup uses request coordinates, coordinates appear nowhere; AS-14 no location → error result, S19 not called; AS-15 invalid input/unknown tool never executed; AS-16 parallel tools concurrent, results in one message in call order; AS-17 5th call has tools disabled, misbehaving model ends `TOOL_LOOP_LIMIT` (G33); AS-18 failing/slow tool → generic error result (fault at S32 double, deadline — G31); AS-19 seller text only inside `tool_result`, prompt/tools unchanged; AS-20 `max_tokens` with `tool_use` never runs the tool; AS-21 `pause_turn` continues and counts toward the round bound (G34).
- [ ] T029 [P] [US2] Unit spec `ASSIST/application/assistant-tools.spec.ts`: input-schema table (`it.each`, AS-15) and closed allowlist of exactly 3 tool names, no URL/recipient fields in schemas (AS-19).
- [ ] T030 [US2] Rewrite `ASSIST/application/assistant-tools.ts` (G29, G30, G32): `search_products` → `ProductSearchService.search` (`surface: 'internal'`, `limit ≤ 20`, typed numbers/booleans, `maxPriceMinor`; drop `ElasticsearchService.searchProducts`); `product_details` → `ProductQueryService.getProductsByIds(ids)` one batch, only visible products, new field names (`priceMinor`, `currency`); `pickup_near_me` → `PickupSearchService.searchNear({q, lat, lng, radiusKm, limit: 5})` result `{hits: items}` with `priceMinor`, `currency`, `category`, `nearest.name`; tool description/prompt tells the model prices are **minor units**; invalid input returns a fixed generic error (no echo); per-tool deadline.
- [ ] T031 [US2] Wire tools into the turn runner: parallel execution, one message in call order, round bound (4 rounds + tools disabled on 5th), `pause_turn` counted, cut-off `tool_use` never run. Remove `ProductModule`/`PickupModule` from `ASSIST/assistant.module.ts` in favor of the R1 modules' exports; if `PickupSearchService` lacks a field, minimal additive export edit in `fulfilment` (list under Sibling follow-ups, already present).

---

## Phase 5: US3 — A dropped connection never loses an answer (P1)

**Independent test**: `test-spec.sh assistant-resume.e2e-spec.ts`.

- [ ] T032 [US3] Create `ASSIST/assistant-resume.e2e-spec.ts` (`describe('Shopping assistant: resumable streams, cancel, abort, shutdown')`) with failing tests: AS-22 resume exactly once in order (+ 50-trial randomized race); AS-23 replay from start / terminal id → empty stream; AS-24 `400 invalid_last_event_id`, newer-than-newest id waits (G1); AS-25 `404 generation_not_found` after 16 min, answer still in history; AS-26 disconnect aborts provider after grace (test grace 300 ms), reconnect within grace does not; AS-27 second tab and second Nest app instance on shared stores (G9); AS-28 cancel aborts within 1 s, `202` twice, nothing persisted; AS-29 cancel of finished generation `409` (G3); AS-30 lost generator → one `GENERATION_LOST`, lock reclaimed, racing reporters write one event (G4, G5); AS-31 next send right after terminal never 409 (100 runs).
- [ ] T033 [US3] Implement generator liveness (`alive` key 5 s refreshed every 1 s), viewer presence keys, grace-abort, cancel flag, terminal-once Lua guard, lock release **before** terminal event is observable, publish failure of terminal retried/reported (G4, G5, G9) in `ASSIST/infra/redis-generation.store.ts` + `ASSIST/application/generation.service.ts`; cross-user stream/cancel = plain `404` (G2); malformed `Last-Event-ID` → `400` (G1); cancel state guard (G3); remote viewer polling adaptive using Redis blocking read, not 300 ms per viewer poll (G9).
- [ ] T034 [US3] Add the WEB journeys to `WEB/tests/assistant.spec.ts`: "connection drop mid-answer resumes and shows full text" (AS-22) and "stop button ends the answer" (AS-28); implement resume/stop in `WEB/hooks/use-assistant-chat.ts` if T026 did not.

---

## Phase 6: US4 — Allowance and capacity protected (P1)

**Independent test**: `test-spec.sh assistant-limits.e2e-spec.ts`.

- [ ] T035 [US4] Create `ASSIST/assistant-limits.e2e-spec.ts` (`describe('Shopping assistant: quotas and limits')`) with failing tests: AS-06 `it.each` combined failures follow the documented order and leave no lock/slot/key/charge (G20); AS-32 exhausted → `429 quota_exceeded` + `Retry-After`, 999/1000 admitted; AS-33 limit from S18 `EntitlementsService`, unreadable → `503`, cold counter seeded from `checkQuota` (G21); AS-34 month roll at 00:00 UTC frozen clock (G23); AS-35 each call charged once, replay ignored, aborted call charged estimate (G22); AS-36 21st message/min → `429 rate_limited`, limiter down → `503`; AS-37 exhausted budget → `429 assistant_busy`, limiter down fails open and counted (G25); AS-39 `Promise.all` 4 sends → exactly 3 accepted, slots back to 0 (G24); AS-40 `Promise.all` two sends same conversation → one 200 one 409, one turn persisted; AS-41 388 refused / 387 accepted via `message_count` (G13); AS-42 `GET /assistant/usage` returns `used, limit, resetsAt`, `503` path (G27).
- [ ] T036 [US4] Implement `ASSIST/application/assistant-admission.service.ts` in the exact AS-06 order with release-on-failure; `metering.service.ts`/quota counter (charge idempotent by `callId` via `assistant:quota-calls` set, failure not swallowed silently — G22); month key/`resetsAt` from injected `Clock` (G23); per-user concurrent cap 3 via Lua slots (G24); real prompt-size weighted cost instead of `COMPACT_AT_TOKENS/4` (G25); lone `lat`/`lng` rejected (G26); lock TTL = turn deadline + 30 s (G28); conversation cap on `message_count` with lazy backfill (G13); ownership checked before rate limit (G20); `GET /assistant/usage` (G27). Remove `assistant-quota.service.ts` local default limit (G21).

---

## Phase 7: US5 — Fallback and breaker (P2)

**Independent test**: `test-spec.sh assistant-resilience.e2e-spec.ts`.

- [ ] T037 [US5] Create `ASSIST/assistant-resilience.e2e-spec.ts` (`describe('Shopping assistant: fallback model, breaker, timeouts')`) with failing tests: AS-38 provider 429 + `Retry-After` cools model fleet-wide (G40); AS-43 primary overloaded before first token → fallback answers, two records (G39); AS-44 failure after streamed text → `PROVIDER_UNAVAILABLE`, nothing persisted; AS-45 both failing → after exactly two attempts; AS-46 5 consecutive failures open primary, zero primary calls, one half-open probe (forced path, VII.9); AS-47 both breakers open → `503 assistant_unavailable` + `Retry-After`, no side effect; AS-48 400/401 not retried, not fallen back, not counted (G41); AS-49 first-token, whole-call and turn deadlines with clock advance (G11, G42); AS-51 provider refusal → `refusal` event, nothing persisted, next turn valid (G46).
- [ ] T038 [US5] Implement `ASSIST/application/model-router.ts`: one `CircuitBreaker` per model (`consecutiveFailures: 5`), Redis cooldown `assistant:cooldown:<model>` honoring `Retry-After`, one fallback only before the first token, failed attempts recorded via `LlmCallRecorder`, non-transient errors bypass breaker, deadlines (first token / call / turn) with injected clock; `503 assistant_unavailable` pre-check when all breakers open (G38–G42, G46).

---

## Phase 8: US6 — Moderation and data hygiene (P2)

**Independent test**: `test-spec.sh assistant-moderation.e2e-spec.ts`.

- [ ] T039 [US6] Create `ASSIST/assistant-moderation.e2e-spec.ts` (`describe('Shopping assistant: moderation and data hygiene')`) with failing tests: AS-52 flagged input → `422 input_rejected`, no side effect, text not logged; AS-53 card number / key-shaped input → `422 sensitive_data` (one positive, one negative); AS-54 flagged chunk not published, `refusal {source:"moderation"}`, nothing persisted, split phrase caught; AS-55 moderator unavailable → input `503`, mid-reply `MODERATION_UNAVAILABLE`, nothing persisted; AS-56 scan of every recorded provider request: no email, ids, token, IP, coordinates, provider end-user id is an opaque hash (G36); AS-57 captured logs contain no text, answers, tool data, coordinates, keys (G37).
- [ ] T040 [US6] Implement moderation in `ASSIST/domain/moderation.ts` + `ASSIST/infra/moderation.adapter.ts` (reuse S47 `Moderator` shape): input check before admission side effects, per-chunk output window before publish, fail-closed; replace `logger.error` stack/`error.message` logging with code-only structured logs in `turn-runner.ts` and `assistant-tools.ts` (G35–G37).

---

## Phase 9: US7 — Long conversations stay coherent (P2)

**Independent test**: `test-spec.sh assistant-context.e2e-spec.ts`.

- [ ] T041 [US7] Create `ASSIST/assistant-context.e2e-spec.ts` (`describe('Shopping assistant: transcript, compaction, atomic persistence')`) with failing tests: AS-58 third turn replays turns 1–2 byte-identically, system/tools frozen, cache breakpoint; AS-59 compaction into one summary (≤ 300 words), marker moves forward only, two racing turns compact once (`IF compacted_up_to < :m`, G15); AS-60 summary failure fails the turn, no compaction recorded (G16); AS-61 `it.each` over 7 outcomes: only `done` persists, in one batch, otherwise zero rows; cancel during second tool round (G12).
- [ ] T042 [US7] Implement persistence and compaction: user message + all rounds + answer written only on `done` as one same-partition batch with `message_count` increment (R-11); compaction via `domain/compaction.ts` decision (count-tokens, fallback estimate), LWT forward-only marker, summary failure → typed error (not `INTERNAL`), summary call metered `"<messageId>:0"` — in `ASSIST/application/conversation.service.ts` and `ASSIST/infra/scylla-conversation.repository.ts` (G12, G13, G15, G16).

---

## Phase 10: US8 — Retried send never creates a second turn (P2)

**Independent test**: `test-spec.sh assistant-turn.e2e-spec.ts -t "AS-6"`.

- [ ] T043 [US8] Add failing tests to `ASSIST/assistant-turn.e2e-spec.ts`: AS-63 same key+body replays stored events (no model call/charge/second turn); AS-64 same key in flight → `409 idempotency_in_flight` with `messageId`; AS-65 different text/location/conversation → `422 idempotency_key_reuse`; AS-66 missing/empty key → `422 idempotency_key_required`; AS-67 keys per user, rejected sends release the key, failed generation keeps it (G19).
- [ ] T044 [US8] Implement idempotency in the admission service: required `Idempotency-Key`, record `{fingerprint, messageId}` at `assistant:idem:{u}:<key>` (15-min window = replay window), replay served from the generation stream (own record, not `IdempotencyInterceptor` — R-6), key released on pre-generation rejection (G19).

---

## Phase 11: US9 — Every model call metered once (P2)

**Independent test**: `test-spec.sh assistant-metering.e2e-spec.ts`.

- [ ] T045 [US9] Create `ASSIST/assistant-metering.e2e-spec.ts` (`describe('Shopping assistant: metering and observability')`) with failing tests: AS-68 four calls → four outbox rows, `callId <messageId>:<n>`, deterministic `eventId`, S18 fields, zero-token call bills 0; AS-69 projector duplicate delivery → one `llm_requests` row, invalid payload → DLQ, no row (VII.4; G52); AS-70 `ttft` null without text, metrics move on forced paths, `assistant_active_streams` back to 0, no user labels (G53); AS-71 outbox append failing 3 times: turn completes, failure counted and logged with `callId` (forced path); AS-73 payload parses with `llmCallCompletedV1`, additive fields present, tolerant of `scopeId`/`outcome`.
- [ ] T046 [US9] Implement `ASSIST/assistant-projector.module.ts` (own imports; boots standalone in `apps/projector` — L-018) and `ASSIST/infra/llm-calls.projector.ts` with invalid-payload → DLQ and idempotent insert by `event_id` (G52); register metrics in `ASSIST/application/metering.service.ts` per `contracts/config-and-policies.md` (TTFT, tokens, fallbacks, aborts, `assistant_active_streams`, admission rejections; no user/conversation labels — G53); record failed, aborted and refused calls in the turn runner (G51).

---

## Phase 12: US10 — Platform runs it safely (P3)

**Independent test**: `test-spec.sh assistant-platform.e2e-spec.ts`.

- [ ] T047 [US10] Create `ASSIST/assistant-platform.e2e-spec.ts` (`describe('Shopping assistant: configuration, shutdown, boundaries')`) with failing tests: AS-74 `it.each` invalid configuration fails startup naming the key (model ids, timeouts, heartbeat vs proxy idle limit — G7, G45); AS-75 SIGTERM: readiness fails, new sends `503`, running replies drained then `SHUTTING_DOWN` (G10); AS-76 runs `pnpm check:boundaries` and `pnpm check:table-ownership --strict` for this lib (clean).
- [ ] T048 [US10] Implement graceful shutdown (`OnApplicationShutdown`/readiness flag, drain with deadline, `SHUTTING_DOWN` terminal) in `ASSIST/application/generation.service.ts`; startup config validation via `LLM/llm-config.ts` + assistant config (G10, G45).
- [ ] T049 [US10] Shrink `ASSIST/index.ts` to `AssistantModule`, `AssistantProjectorModule`, S47's modules/types, policies, event contracts only (G57, D-8); delete `ASSIST/infra/llm`, `generation-buffer.ts`, `conversation.store.ts`, `assistant-quota.service.ts`, old `assistant.e2e-spec.ts` (G58 — only after every old scenario has a row above, L-017); fix any importer of removed exports (`grep -rn "@app/domains/assistant"`).

---

## Phase 13: Polish and cross-cutting

- [ ] T050 [P] Grep that every `AS-01`…`AS-77` appears in exactly one test title (`grep -rhoE "AS-[0-9]{2}" …`), including unit specs; fix gaps (L-017).
- [ ] T051 [P] Close `docs/work/architecture/debt-register.md` rows D-6 (assistant), D-8, D-14 with the actual commit; leave D-7/D-12 as S47 notes. Update `docs/spec/capabilities/S46-shopping-assistant.md` to final behavior; `python3 scripts/livespec/check.py` clean.
- [ ] T052 [P] Confirm `gaps.md` `## Sibling-spec follow-ups` (S54, S19, S18, S04, S47, W05, S50, S05/S32) and `## Spec changes` still match the code; add bullets for anything new. Do not edit sibling specs.
- [ ] T053 [P] Confirm Ops artifacts: `quickstart.md` lists SC-001, SC-003 (prod timings), SC-007, SC-010 and `specs/UNVERIFIED.md` rows (lines for S46 present) say "not run"; never describe them as verified.
- [ ] T054 Sweep for rule (4): `grep -rn "sequelize.transaction" ASSIST` count is not above `.tx.baseline`; remove any `// S54 T037 audit` comment on a touched site.
- [ ] T055 Queue/topic check (L-001/L-002/L-020): confirm the relay topic `llm.call_completed` exists in the test stack; no new queue added; run the doctor.
- [ ] T056 Final checkpoint with scripts (L-019, L-008, L-012): `scripts/qa/fresh-run.sh` on an empty stack; each capability spec file in its own process (rows 5–13 of quickstart); `test-spec.sh libs/domains/assistant/knowledge` and `libs/domains/seller-onboarding`; `tsc --noEmit`, ESLint, `pnpm check:boundaries`, `pnpm check:table-ownership --strict`; boot `apps/core`, `apps/sse-gateway`, `apps/projector` standalone (T013 repeat); `pnpm --dir ../web test:e2e assistant` on an empty stack (2 workers, runner timeouts). Expect `assistant_active_streams` = 0 and no `assistant:lock:*`/`assistant:slots:*` leftovers.

---

## Dependencies and order

- Phase 1 → Phase 2 (2a lib → 2b primitives/adapters) → stories. T013 boot proof before US1.
- US1 (T021–T027) is the MVP and required by all other stories (turn pipeline). After US1: US2, US3, US4, US5, US6, US7 touch different test files and mostly different services; they can run in parallel by file ownership, except they all edit `turn-runner.ts`/`assistant-turn.service.ts` (serialize those edits: US2 → US3 → US4 → US5 → US6 → US7).
- US8 depends on US4 admission service (T036). US9 depends on T009 and US5 (failed attempts recorded). US10 depends on all (T049 last of code tasks).
- Polish after all stories.

## Parallel examples

- Phase 2: T005, T006, T011, T014, T016, T018, T020 (distinct files) together; then T007–T010, T015, T017, T019.
- Test-file authoring: T028/T029, T032, T035, T037, T039, T041, T045, T047 can be written in parallel once US1 exists (each a different spec file).

## Implementation strategy

- **MVP** = Phases 1–3 (US1) with the shared lib and domain primitives: streamed, persisted, authenticated turns and conversation CRUD.
- Then P1 stories (US2 tools, US3 resume, US4 limits), then P2 (US5–US9), then P3 (US10) and polish. Each phase ends green and committable.
- Test-first throughout: the spec-file task of a phase precedes its implementation task; run the narrowest file after each implementation task, the whole capability suite once at the end (T056).

## Coverage

- Every gaps.md item has a task: G1 T033; G2 T022/T033; G3 T033; G4 T033; G5 T033; G6 T019; G7 T023/T048; G8 T023; G9 T033; G10 T048; G11 T023/T038; G12 T042; G13 T036/T042; G14 T022; G15 T042; G16 T042; G17 T002/T022; G18 T002; G19 T044; G20 T036; G21 T036; G22 T036; G23 T017/T036; G24 T036; G25 T036; G26 T022/T036; G27 T036; G28 T036; G29–G30 T030; G31 T030; G32 T030; G33–G34 T031; G35–G37 T040; G38–G42 T038/T007; G43–G45 T008; G46 T038; G47–G51 T009/T046; G52 T046; G53 T046; G54 T009; G55 T004/T024; G56 T017; G57 T049; G58 T021…T047/T049; G59 T026. Debt: D-6 T024/T051, D-8 T049, D-14 T009/T010/T051.
- Inherited follow-ups: S05 T030; S13/S54 `CircuitBreaker` T015/T038; S19 `PickupSearchService` T030; S32 T030; S47 ports/adapters T010 and key parsing T008, policies T020; S50 T020/T026.
