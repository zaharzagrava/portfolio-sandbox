# Implementation Plan: S46 — Streamed Shopping Assistant (domain `assistant`, shopping half)

**Branch**: `S46-shopping-assistant` (checked out as `sdd/auto`) | **Date**: 2026-10-15 | **Spec**: [spec.md](./spec.md)

**Input**: `spec.md` (AS-01…AS-77, FR-001…FR-043, SC-001…SC-010), `test-plan.md`, `gaps.md` (G1–G59, debt D-6/D-8/D-14), `questions.md` (defaults accepted as written; no line was edited by a human). Plus the follow-ups other specs left for S46 (listed under "Inherited requirements").

## Summary

Bring today's `assistant` shopping half (a working but non-conforming SD-42 implementation: 626-line `AssistantService`, Redis-stream `GenerationBuffer`, Scylla `ConversationStore`, provider code under `assistant/infra/llm`) to the spec, in this order of risk:

1. **Shared LLM lib** `libs/infrastructure/llm` (new, domain-agnostic): `LlmProvider` port, Anthropic + scripted adapters, pure `billableTokens` / `costMicros` / `estimateTokens`, `LlmCallRecorder` (outbox `llm.call_completed` v1), typed errors, startup validation. The assistant, S47's three interim adapters and seller-onboarding (S04) switch to it; `assistant/infra/llm` is deleted and `assistant/index.ts` stops exporting provider internals (D-14, D-8).
2. **Turn pipeline rebuilt behind ports** (D-6): a pure `domain/` (generation state machine, admission order, request fingerprint, text coalescer, output window, billable tokens re-export, compaction decision) and `application/` use cases that inject tokens only. `infra/` adapters keep Redis (lock, slot, counters, replay stream, idempotency records, cooldowns, liveness) and Scylla (transcript, one same-partition batch per `done` turn).
3. **Admission in the exact AS-06 order** with release-on-failure, idempotency keys, month allowance from S18 (fail closed), `llm.messages` / `llm.provider.tpm` policies, per-user concurrent cap, conversation cap.
4. **Reliability**: per-model breaker built on `@app/common/resilience` `CircuitBreaker` (additive `consecutiveFailures` mode, see R-4), fleet-wide provider cooldown, one fallback before the first token, deadlines, generator liveness, shutdown drain.
5. **Safety**: moderation port (S47's `Moderator` shape reused, S47's rule-based sensitive-data function reused), per-chunk output window, tools only through R1 services (S32, S05, S19), no PII in prompts/logs.
6. **Contracts + client**: `packages/contracts/src/assistant/*` schemas; `packages/web` assistant hook/API send `Idempotency-Key`, parse schemas, handle new codes; e2e specs rewritten into the ten files of `test-plan.md`.

## Technical Context

**Language/Version**: TypeScript (strict) on Node, NestJS monorepo (`packages/backend`), Next.js web (`packages/web`), shared Zod schemas (`packages/contracts`).

**Primary Dependencies**: `@anthropic-ai/sdk` (existing), `ioredis` through `RedisService`, `cassandra-driver` through `CassandraModule`, `OutboxService` (S53), `RateLimitModule.forFeature` / `definePolicies` (S50), `CircuitBreaker` + `Clock` + `MetricsRegistry` + problem filter (S54), `EntitlementsService` (S18, R1), `ProductSearchService` (S32, R1), `ProductQueryService` (S05, R1), a new `PickupNearMeService` export (S19, R1), `fast-check` (existing dev dependency).

**Storage**: Scylla `assistant_conversations_by_user`, `assistant_messages_by_conversation` (owned; additive columns, see data-model.md); Redis keys under `assistant:` (owned); ClickHouse `llm_requests` (owned, consumed by the `llm-calls-log` projector); outbox table (S53). No Postgres tables owned by the shopping half.

**Testing**: Jest e2e through `scripts/sdd/test-spec.sh` against the real stack with the scripted provider at the system edge; unit specs under `domain/` and `libs/infrastructure/llm/`; Playwright for four web journeys. Layer per scenario: `test-plan.md`.

**Target Platform**: Linux containers; `apps/sse-gateway` (streams), `apps/core` (wiring), `apps/projector` (`AssistantProjectorModule`).

**Project Type**: backend library (domain) + shared infrastructure lib + web client + contracts.

**Performance Goals**: first words ≤ 1.5 s p95 when the model's first token is < 1 s (platform adds < 500 ms); 5,000 concurrent streams per instance; 230 msg/s avg, 3,000 msg/s peak over 10 instances.

**Constraints**: every outbound call has an explicit timeout; heartbeat ≤ 25 s; rejected sends leave no lock/slot/key/charge; replay window 15 min = idempotency window; no message text, answers, tool data, coordinates, tokens or keys in logs, prompts (beyond the transcript itself), metrics labels or analytics.

**Scale/Scope**: 8 HTTP routes, 6 stream event types, 3 tools, 1 shared lib, 1 event contract, 77 acceptance scenarios.

## Constitution Check (v3.1.0)

| Principle | Gate | Status / how |
|---|---|---|
| I.2 Layering (D-6) | `api/`,`application/` import no `infra/` class; `domain/` has no framework, time via injected clock | **Plan satisfies**: ports in `domain/ports.ts` (extended), tokens in `domain/tokens.ts`; AS-76 runs `check:boundaries` |
| II Request pipeline | `Firewall()`, problem filter, rate-limit via policy | satisfied; validation DTOs at the edge (400), ownership 404 |
| III.3/III.4 Data access | principal in every lookup predicate; no load-then-check | **Fixes G2**: ownership is part of the Redis key / Scylla partition (`user_id, conversation_id`) |
| III transactions / rule (4) | no new `sequelize.transaction`; migrate any `// S54 T037 audit` site touched | The shopping half opens none (grep: 0 direct sites; baseline `.tx.baseline` is 0-compatible). Outbox append is `append(event)` through `OutboxService`, in the caller's transaction when there is one, else `appendStandalone` |
| IV.4 No dual write | usage reaches billing only through the outbox event | **Fixes G47**: `UsageService` and direct Kafka produce removed |
| V Errors | RFC 9457 + stable `code` + `requestId`; existence hidden | all rejections in contracts/http-api.md; foreign ids → `404 not_found` |
| V.6 Idempotency | paid write requires key | `Idempotency-Key` required; own Redis record (the stream replay, not a stored response body, is what is replayed, so the generic `IdempotencyInterceptor` does not fit — R-6) |
| VII Testing | one e2e file per feature, forced-path tests, concurrency by `Promise.all`, DLQ test | `test-plan.md` mapping kept; tasks create each file |
| VIII Operational safety | timeouts, shutdown, config validated at start | AS-49, AS-74, AS-75 |
| IX / X Isolation & boundaries | no foreign model/SQL; R1 exports only; no `infra/` of other domains | tools use S32/S05/S19 exports; `EntitlementsService` imported from `BillingModule`, not re-provided; `UsageService` gone; lib `infrastructure/llm` imports no domain |
| X.4 Barrel | modules, DTO types, event contracts only | `index.ts` shrinks to `AssistantModule`, `AssistantProjectorModule`, S47's modules/types, policies |

**Gate result: PASS.** One deliberate extension to a shared lib (`CircuitBreaker` gains an additive `consecutiveFailures` option) is recorded in Complexity Tracking.

Post-design re-check (after Phase 1): unchanged — PASS. The only cross-domain edit is S19's missing export, handled as a **requirement on S19 with a minimal additive export in this run** (see Inherited requirements, S19 row) because the build must stay green; it is also listed under "Sibling-spec follow-ups" in `gaps.md`.

## Inherited requirements (follow-ups from built specs) — each is planned and tested

| From | Requirement | Where planned | Proof |
|---|---|---|---|
| S05 | Replace `ProductService.search/findById` / `ProductModel` reads by `ProductQueryService.getProductsByIds(ids)` (one batch); search is S32's, not `ElasticsearchService.searchProducts` | Phase C (tools), R-8 | AS-11, AS-12 (TOOLS) |
| S13 / S54 | Reuse `CircuitBreaker` from `@app/common/resilience`; no private breaker; payment config is not shared | Phase B, R-4 | AS-46/47 (RESIL) + unit state-table |
| S19 | `pickup_near_me` adopts `PickupSearchService.searchNear({q, lat, lng, radiusKm, limit})` result `{hits: items}` with `priceMinor`, `currency`, `category`, `nearest.name`; tool text tells the model price is **minor units**. The spec asked for `PickupNearMeService`; the built S19 exports `PickupSearchService` — **adopt the built name**, keep the spec's contract shape | Phase C, R-9 | AS-13/14 (TOOLS) |
| S32 | Switch from `ElasticsearchService.searchProducts` (pre-S32 shape `price`/`priceMax`) to `ProductSearchService.search` (`surface: 'internal'`, `limit ≤ 20`, typed numbers/booleans, `maxPriceMinor`) | Phase C | AS-11 |
| S47 | Export the three ports `AnswerModel`, `CallRecorder`, `Moderator` so each S47 adapter is replaced in one file: `LlmCallRecorder` replaces `infra/call-recorder.adapter.ts`, the `LlmProvider` replaces `infra/answer-model.adapter.ts`'s direct use of `assistant/infra/llm`, the moderation port replaces `infra/moderator.adapter.ts`. `llm.call_completed` v1 stays tolerant of optional `scopeId` and `outcome` | Phase A, R-3, R-10 | AS-73, AS-77, S47 specs stay green |
| S47 | Parse `anthropic_api_key` and `assistant_model` from the environment so the scripted provider is no longer bound everywhere; S47's `KnowledgeConfigGuard` then refuses it in production | Phase A | AS-74 |
| S47 | Keep `llm.messages` and `llm.provider.tpm` in `rate-limit-policies.ts` once `rag.ask` lives in S47's policies file (it already does) | Phase B | AS-36/37 |
| S50 | `definePolicies` + `forFeature` (already used); adopt structured `RateLimit`/`RateLimit-Policy` headers, `503 rate_limiter_unavailable`, `422 rate_limit_cost_exceeded` in contracts and client | Phase B, contracts/http-api.md | AS-36, AS-37, WEB |
| S54 | `CircuitBreaker` from `@app/common/resilience` instead of a private breaker | as S13 row | as above |
| gaps.md | Every item G1–G59 and D-6, D-8, D-14 (D-7/D-12 are S47 notes only) | Task groups below | `test-plan.md` |

## Project Structure

### Documentation (this feature)

```text
specs/domains/S46-shopping-assistant/
├── plan.md           # this file
├── research.md       # decisions R-1 … R-14
├── data-model.md     # stores, keys, entities, state machines
├── quickstart.md     # runnable validation + Ops artifacts
├── contracts/
│   ├── http-api.md           # 8 routes, problem codes, headers
│   ├── stream-events.md      # SSE protocol, event schemas, resume rules
│   ├── llm-call-completed-v1.md   # outbox event
│   ├── llm-port.md           # @app/infrastructure/llm public surface
│   └── config-and-policies.md     # config keys, rate-limit policies, metrics
└── tasks.md          # created by /speckit-tasks
```

### Source code (repository root)

```text
docs/spec/capabilities/S46-shopping-assistant.md      # NEW living page, written first (rule 0)

packages/contracts/src/assistant/
├── conversation.ts  history.ts  send-message.ts  stream-events.ts  usage.ts  llm-call-completed.ts   # NEW; index re-exports

packages/backend/libs/common/resilience/circuit-breaker.ts      # additive option: consecutiveFailures

packages/backend/libs/infrastructure/llm/                        # NEW, moved from assistant/infra/llm
├── llm.module.ts  llm-provider.ts (port, errors)  anthropic.provider.ts  scripted.provider.ts
├── pricing.ts  billable-tokens.ts  backoff.ts  llm-call-recorder.ts  llm-config.ts
├── index.ts
└── *.spec.ts  llm-provider.e2e-spec.ts   (ADAPTER)

packages/backend/libs/domains/assistant/
├── domain/        # NEW: generation-state.ts  admission.ts  request-fingerprint.ts  text-coalescer.ts
│                  #      output-window.ts  stream-id.ts  month.ts  compaction.ts  conversation-cursor.ts
│                  #      assistant-ports.ts (tokens + interfaces)  moderation.ts  (+ *.spec.ts)
├── application/   # assistant-turn.service.ts (admission + orchestration)  turn-runner.ts (model/tool loop)
│                  # assistant-admission.service.ts  conversation.service.ts  generation.service.ts
│                  # assistant-tools.ts (R1 services)  model-router.ts (fallback+breaker+cooldown)
│                  # metering.service.ts  assistant-errors.ts   (assistant.service.ts, assistant-quota.service.ts removed/split)
├── infra/         # redis-generation.store.ts (replaces generation-buffer.ts)  scylla-conversation.repository.ts
│                  # redis-admission.adapter.ts (lock, slot, counter, idempotency, cooldown)  moderation.adapter.ts
│                  # llm-calls.projector.ts (DLQ)  (S47 adapters become one-file re-bindings)
├── api/           # assistant.controller.ts  assistant-dto.ts  assistant-stream.ts (viewer loop only)
├── assistant.module.ts  assistant-projector.module.ts (NEW)  index.ts (shrunk)
├── assistant-{turn,tools,resume,limits,resilience,moderation,context,metering,platform}.e2e-spec.ts   # replaces assistant.e2e-spec.ts

packages/backend/libs/domains/seller-onboarding/…  # imports switch to @app/infrastructure/llm (S04 follow-up kept minimal)
packages/backend/libs/domains/fulfilment/…         # only if PickupSearchService lacks a field in R-9
packages/web/hooks/use-assistant-chat.ts  packages/web/lib/api/assistant.ts  packages/web/tests/assistant.spec.ts
docs/work/architecture/debt-register.md            # close D-6 (assistant), D-8, D-14 with the commit
```

**Structure Decision**: keep the domain lib layout (`api/ application/ domain/ infra/`), add one infrastructure lib for the provider, no new app. The shopping half and S47's knowledge half share the lib directory but no file (S47 scope list in its living page does not include `assistant.service.ts`, `generation-buffer.ts` or `conversation.store.ts`).

## Delivery phases (input to `/speckit-tasks`; each ends green and committable)

- **Phase 0 — Living spec + contracts first.** Write `docs/spec/capabilities/S46-shopping-assistant.md` (current behavior, then the rules above), run `python3 scripts/livespec/check.py`. Add contracts schemas (G18) with tests. No `*.reviewed.json`.
- **Phase A — `@app/infrastructure/llm`.** Move + extend (G42–G45, G47–G51, AS-50, AS-62, AS-72, AS-74, AS-77); keep `assistant/index.ts` re-exports as thin aliases only until Phase E removes them; switch S47 adapters, S04, projector wiring; prove standalone boot of `apps/core`, `apps/projector`, `apps/sse-gateway` (L-015, L-018).
- **Phase B — Domain + admission + reliability.** Ports, state machine, fingerprint, coalescer, month, stream ids; admission pipeline and quota (G13, G19–G28, G38–G41, G55–G56); breaker, cooldown, deadlines; metrics (G53).
- **Phase C — Turn, stream, tools, safety.** Generation store with liveness, viewers, cancel, shutdown (G1–G12); atomic persistence + compaction (G12–G17, G46); moderation (G35–G37); tools via R1 (G29–G34).
- **Phase D — Metering + projector.** Recorder in turn path, DLQ, retries (G47–G54).
- **Phase E — Cleanup + client + e2e.** Barrel shrink (G57), module wiring, web client (G59), rewrite e2e into ten files (G58), debt register, `UNVERIFIED.md`, boundary/ownership checks.
- **Final checkpoint** (scripts, not agents' claims; L-019): real apps boot on their own; `scripts/qa/fresh-run.sh` on an empty stack (L-012); capability suite once in batches (L-008); Playwright suite once.

## Known-failure-class guards (from the prompt)

- **L-001/L-002/L-020**: S46 adds **no queue**. The outbox relay topic `llm.call_completed` is the one that S47's interim adapter already uses; if the relay names a queue/topic not yet in `elasticmq.conf`/Kafka bootstrap, the doctor check is run before closing.
- **L-003**: no "A or B" assertions; the fallback/limit tests assert the exact code. An unavailable external double is reported *blocked*.
- **L-004/L-015/L-018**: Phase A and E boot `apps/core`, `apps/sse-gateway`, `apps/projector` standalone and the real API (not jest only); `AssistantProjectorModule` must carry its own imports.
- **L-005/L-006**: tests create their own users, conversations and products (`createIsolatedProduct`); no shared month counter between files (each test uses a fresh user id).
- **L-007**: runner timeouts, 2 workers; no waits on loads a redirect aborts.
- **L-010**: `POST /conversations` is not "create on first use"; the web hook creates a conversation once per sheet open and treats `409` as "open existing" if ever added. Idempotency keys make the send double-fire safe under React dev double effects.
- **L-013**: forced-failure tests (breaker, outbox, limiter) restore the injector in `afterEach`.
- **L-017**: tests are renamed/merged freely; the scenario → test mapping in `test-plan.md` stays 1:1 for AS-01…AS-77 (checked by a grep over `AS-nn` in test titles).
- **Rule (4) transactions**: none opened. Rule (1): sibling follow-ups recorded in `gaps.md`. Rule (2): unverified SCs in `quickstart.md` and `specs/UNVERIFIED.md`. Rule (3): no checkout/restore/reset/stash/clean.

## Complexity Tracking

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| `CircuitBreaker` gets an additive `consecutiveFailures` option (S54-owned file) | AS-46 says "5 consecutive transient failures; a success resets the count"; the shared breaker is rate-in-window | A rate of 1.0 over `minimumCalls: 5` stays closed while one old success is still in the window — fails the scenario. A private breaker is forbidden by S13/S54 follow-ups. Change is additive, default unchanged, covered by new rows in `circuit-breaker.spec.ts`; recorded under "Spec changes" if S54's page says otherwise |
| Own idempotency record instead of S53 `IdempotencyInterceptor` | A replay re-serves an SSE event stream from the generation buffer; the interceptor stores a single response body | Storing the stream as a body defeats resume/`Last-Event-ID` and doubles memory |
| `PickupSearchService` (built) instead of spec's `PickupNearMeService` | The sibling shipped the former (S19 follow-up); creating a second export duplicates it | Naming mismatch is a spec text change only; contract shape identical |
