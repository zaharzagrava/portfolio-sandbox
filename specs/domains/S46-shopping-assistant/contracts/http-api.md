# Contract: assistant HTTP API (global prefix `/api`)

All routes require `Firewall()` (`401 unauthenticated` otherwise). Errors are `application/problem+json` with `type, title, status, detail, instance, requestId, code`. Schemas live in `packages/contracts/src/assistant/` and are the single source for backend DTOs and the web client.

| Route | Request | Success | Schema |
|---|---|---|---|
| `POST /assistant/conversations` | `{title?: 1–120}` | `201` | `assistantConversationSchema {id, title, updatedAt, messageCount}` |
| `GET /assistant/conversations?limit&cursor` | `limit` 1–50 (default 20) | `200` | `assistantConversationListSchema {items, nextCursor: string or null}` |
| `DELETE /assistant/conversations/:id` | — | `204` | — |
| `GET /assistant/conversations/:id/messages` | — | `200` | `assistantHistorySchema {conversation:{id,title,updatedAt}, messages:{id,turnId,role,text,tools:string[]}[]}` |
| `POST /assistant/conversations/:id/messages` | header `Idempotency-Key` (required); body `assistantSendMessageRequestSchema {text, lat?, lng?}` strict | `200 text/event-stream`; `Idempotent-Replay: true` on replay | stream events |
| `GET /assistant/messages/:messageId/stream` | header `Last-Event-ID?` `<digits>-<digits>` | `200 text/event-stream` | stream events |
| `POST /assistant/messages/:messageId/cancel` | — | `202 {cancelling: true}` | — |
| `GET /assistant/usage` | — | `200` | `assistantUsageSchema {used, limit, resetsAt}` |

Rate-limit policy `llm.messages` on the send route; responses carry the structured `RateLimit` / `RateLimit-Policy` headers (S50).

## Problem codes

| Status | `code` | Extra fields | Scenarios |
|---|---|---|---|
| 400 | `validation_failed` (names the field), `invalid_cursor`, `invalid_last_event_id` | `errors[]` | AS-03, 07, 24 |
| 401 | `unauthenticated` | | AS-04 |
| 404 | `not_found` (also foreign ids), `generation_not_found` | | AS-05, 25, 29 |
| 409 | `turn_in_progress`, `conversation_full`, `generation_finished`, `idempotency_in_flight` | `messageId` on the last | AS-09, 29, 40, 41, 64 |
| 422 | `idempotency_key_required`, `idempotency_key_reuse`, `input_rejected`, `rate_limit_cost_exceeded` (S50) | `category` on `input_rejected` | AS-52, 53, 65, 66 |
| 429 | `rate_limited`, `quota_exceeded`, `assistant_busy`, `too_many_active_turns` | `Retry-After`; quota adds `used, limit, resetsAt` | AS-32, 36, 37, 39 |
| 503 | `assistant_unavailable`, `rate_limiter_unavailable` (S50) | `Retry-After` | AS-33, 36, 47, 55, 75 |

## Admission order (AS-06)

The order is a constant in `domain/admission.ts`: authentication → validation → idempotency key → ownership → `llm.messages` → input moderation → conversation size → allowance → conversation lock → user slot → `llm.provider.tpm` → breakers. Every failure unwinds everything taken before it.
