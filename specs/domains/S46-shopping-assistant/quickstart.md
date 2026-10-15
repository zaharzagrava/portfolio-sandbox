# Quickstart: validating S46

Run from `packages/backend` unless noted. Specs go through `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern> [jest args]` (condensed result plus the path of the full log). Narrowest test first, the whole capability once at the end, in batches of fresh processes (L-008).

## Prerequisites

- Stack up (Postgres, Redis, Scylla, Kafka stand-in, ClickHouse, outbox relay): `scripts/qa/fresh-run.sh` for an empty-stack run (L-012); the test stack must have the `llm.call_completed` topic and the `llm_requests` table (compare with the doctor, L-011).
- Provider: the scripted adapter, installed at the system edge by the specs. No API key is needed; a real key is only for Ops artifacts.

## Validation scenarios (automated)

| Step | Command | Proves |
|---|---|---|
| 1 Living spec | `python3 scripts/livespec/check.py` (repo root) | the S46 page's `[proof:]` / `[code:]` references are true |
| 2 Contracts | `test-spec.sh packages/contracts` (schema specs) | every request, response, event and the `llmCallCompletedV1` parse |
| 3 Pure logic | `test-spec.sh libs/infrastructure/llm libs/domains/assistant/domain libs/common/resilience` | AS-10, 34, 35, 37, 46 (state table), 53, 54, 59, 62, 65, 72, 74 |
| 4 Provider port | `test-spec.sh libs/infrastructure/llm/llm-provider.e2e-spec.ts` | AS-50, AS-77 |
| 5 Turn and history | `test-spec.sh assistant-turn.e2e-spec.ts` | AS-01…09, 63…67 |
| 6 Tools | `test-spec.sh assistant-tools.e2e-spec.ts` | AS-11…21 |
| 7 Resume, cancel, crash | `test-spec.sh assistant-resume.e2e-spec.ts` | AS-22…31 (includes the 50-trial and 100-run loops) |
| 8 Limits | `test-spec.sh assistant-limits.e2e-spec.ts` | AS-06, 32…42 |
| 9 Resilience | `test-spec.sh assistant-resilience.e2e-spec.ts` | AS-38, 43…49, 51 |
| 10 Safety | `test-spec.sh assistant-moderation.e2e-spec.ts` | AS-52…57 |
| 11 Context | `test-spec.sh assistant-context.e2e-spec.ts` | AS-58…61 |
| 12 Metering | `test-spec.sh assistant-metering.e2e-spec.ts` | AS-68…71, 73 |
| 13 Platform | `test-spec.sh assistant-platform.e2e-spec.ts` | AS-74…76 (runs `pnpm check:boundaries` and `pnpm check:table-ownership --strict`) |
| 14 S47 stays green | `test-spec.sh libs/domains/assistant/knowledge` and `libs/domains/seller-onboarding` | the moved provider and recorder |
| 15 Web | `pnpm --dir ../web test:e2e assistant` (empty stack, runner timeouts, 2 workers) | four happy-path journeys |
| 16 Boot | start `apps/core`, `apps/sse-gateway`, `apps/projector` each on its own and call `GET /api/assistant/usage` (401 without a session) | L-004, L-015, L-018 |

Expected outcome: all green, zero findings from the two static checks, `assistant_active_streams` back to 0 after the suite, no key under `assistant:lock:*` or `assistant:slots:*` left by rejected sends.

## Ops artifacts (not proven by an automated test; status "not run")

| Criterion | How to run it |
|---|---|
| SC-001: first words within 1.5 s at p95 (platform adds < 500 ms) | k6 against a staging instance with a provider double whose first token takes 800 ms; read `assistant_ttft_seconds` against the client's first `text` event; 10 000 sends |
| SC-003 (production timings): provider call stops within grace + 2 s when nobody watches | with the default grace of 10 s, 100 runs of start-and-disconnect against a provider double that records aborts; AS-26 proves the mechanism with the 300 ms test grace |
| SC-007 (end to end): billed tokens in billing equal the sum of per-call records and a duplicated delivery changes it by 0 | run 500 turns, replay the topic, compare S18's `/me/usage` total with `sum(billableTokens)` from `llm_requests`; the S46 half (one record per call, deterministic event id) is proven by AS-68/AS-69 |
| SC-010: 5,000 concurrent streams per instance at the budget; 230 msg/s average and 3,000 msg/s peak across 10 instances without budget exhaustion becoming slow failures | k6 SSE load test (10 instances, slow provider double), watch CPU, memory, `assistant_admission_rejected_total{reason="busy"}`, p99 of 429 answers |

SC-002, SC-004, SC-005, SC-006, SC-008, SC-009 are proven by AS-22 (50 trials), AS-06/AS-32…41 (no side effect), AS-43, AS-05, AS-13/AS-15/AS-57, AS-63.
