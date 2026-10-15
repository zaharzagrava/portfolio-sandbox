# Data model: S46

Stores are owned by the `assistant` domain. Names of existing tables/keys are kept where they already exist; additions are additive. Exact column types: see the migration notes at the end.

## Entities

### Conversation (Scylla `assistant_conversations_by_user`, partition `user_id`, clustering `conversation_id` time-UUID DESC)
| Field | Type | Rule |
|---|---|---|
| user_id | uuid | owner; part of every lookup key |
| conversation_id | timeuuid | creation order = list order (keyset cursor = last `conversation_id`) |
| title | text | trimmed, 1–120, default "New chat" |
| updated_at | timestamp | set when a turn is persisted |
| message_count | int (**new**) | maintained with the turn batch (R-11); replaces `count(*)` |
| summary | text, null | one `<conversation_summary>`, ≤ 300 words |
| compacted_up_to | timeuuid, null | only moves forward (`IF compacted_up_to < :m`) |

### Message (Scylla `assistant_messages_by_conversation`, partition `(user_id, conversation_id)`, clustering `message_id` timeuuid ASC)
`role` (`user`|`assistant`), `content` (JSON blocks, verbatim incl. thinking, tool_use, tool_result), `turn_id` (the generation's `messageId`), `visible_text`, `tool_names list<text>`. Append-only; written only by the `done` batch; deleted only with the conversation. `user_id` is added to the partition key if the current table lacks it (check the schema file at task time; if the current key is `conversation_id` only, migrate additively by a new table and read-through — decision recorded in the task).

### Generation (Redis, hash-tagged `{<userId>:<messageId>}`)
| Key | Type | TTL | Content |
|---|---|---|---|
| `assistant:gen:{u:m}:stream` | stream | replay window after end | events `meta/text/tool/done/refusal/error`; entry id = SSE id |
| `assistant:gen:{u:m}:meta` | hash | same | `conversationId, state, startedAt, endedAt?, terminal?` |
| `assistant:gen:{u:m}:alive` | string | 5 s, refreshed every 1 s | generator liveness |
| `assistant:gen:{u:m}:viewer:<viewerId>` | string | 5 s per poll | presence |
| `assistant:gen:{u:m}:cancel` | string | replay window | cancel requested |
| `assistant:gen-owner:<messageId>` | string → userId | replay window | **not used for authorization**; only lets a foreign caller be answered `404` in the same code path as unknown |

Authorization = the lookup key contains the caller's id (a foreign id is a plain miss).

**State machine** (`domain/generation-state.ts`): `running → done | refusal | error`. `error.code` ∈ `CANCELLED, PROVIDER_UNAVAILABLE, TURN_TIMEOUT, GENERATION_LOST, MODERATION_UNAVAILABLE, SHUTTING_DOWN, TOOL_LOOP_LIMIT, INTERNAL`. Terminal states final; terminal written once (Lua guard). Cancel: `running → running(cancelRequested)`; on a terminal state → `409 generation_finished`; after expiry → `404`.

### Admission state (Redis)
| Key | Purpose | TTL |
|---|---|---|
| `assistant:lock:{u}:<conversationId>` | one reply per conversation; value = messageId; compare-and-delete | turn deadline + 30 s |
| `assistant:slots:{u}` | active replies per user, capped by Lua | turn deadline + 30 s refreshed |
| `assistant:quota:{u}:<YYYYMM>` | month tokens (integer) | month end + 7 d |
| `assistant:quota-calls:{u}:<YYYYMM>` | set of charged `callId`s (idempotent charge) | same |
| `assistant:idem:{u}:<key>` | `{fingerprint, messageId}` | replay window |
| `assistant:cooldown:<model>` | provider `not before` instant (fleet-wide) | cooldown |

### Model call record (outbox row → Kafka `llm.call_completed`, ClickHouse `llm_requests`)
Fields in `contracts/llm-call-completed-v1.md`. `callId = "<messageId>:<n>"`, summary `"<messageId>:0"`; `eventId` = UUIDv5(callId).

### Breaker / cooldown
Breaker per model: in-process (`CircuitBreaker`). Cooldown: Redis key above.

## Validation rules (single source: `packages/contracts/src/assistant`)
`text` 1–4000 chars after trim; `lat` −90…90 and `lng` −180…180, both or neither; no unknown fields (strict); `:id` time-UUID; `Idempotency-Key` `[A-Za-z0-9_-]{1,128}`; title 1–120; list `limit` 1–50 default 20; cursor opaque base64url of the last conversation id, malformed → `400 invalid_cursor`.

## Derived values
- `billableTokens = input + cacheWrite + output + ceil(cacheRead/10)`; `costMicros` integer from the price table; `estimateTokens = ceil(chars/4)`.
- Month key = `YYYYMM` of `clock.now()` in UTC; `resetsAt` = first instant of next UTC month.
- Admission weighted cost = `ceil(chars(system+tools+text)/4) + 15_000 + 2_000`, capped at 2,000,000.
- Conversation cap: refuse when `message_count > 388`.

## Migration notes
- Scylla: `ALTER TABLE … ADD message_count int` (nullable; absent = computed once by a lazy backfill on first send: `count(*)` then LWT set). Idempotent migration file in the existing Cassandra migrations folder (find with `grep -rn assistant_conversations_by_user`).
- ClickHouse `llm_requests`: add columns `call_id, subject_id, metric, billable_tokens, outcome, usage_estimated, purpose` (additive); de-duplication by `event_id` stays.
- Redis: no migration; old `assistant:gen:{messageId}` keys expire within the old 10 min window.
