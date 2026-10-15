# Contract: reply stream (SSE)

Headers on every stream (send or resume): `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. First bytes `retry: 2000`. Heartbeat comment `: ping` every `assistant_heartbeat_ms` (default 15 000, max 25 000) while silent; no `id:`, never stored.

Events (`event:` name, `id:` = stream id `<ms>-<seq>`, strictly increasing; `data:` JSON; schema `assistantStreamEventSchema`, discriminated by name). No other event type is ever sent.

| Event | Data |
|---|---|
| `meta` | `{messageId, conversationId}` (first) |
| `text` | `{t}` — coalesced: at most 1 per 40 ms or 256 chars; all flushed before the terminal event |
| `tool` | `{id, name, status: 'running' / 'done' / 'failed'}` |
| `done` | `{stopReason, truncated, usage:{inputTokens, outputTokens}, allowance:{used, limit}}` — no cost, model name, cache counters |
| `refusal` | `{category, source: 'provider' / 'moderation'}` |
| `error` | `{code, retryAfterMs?}`; codes: `CANCELLED, PROVIDER_UNAVAILABLE, TURN_TIMEOUT, GENERATION_LOST, MODERATION_UNAVAILABLE, SHUTTING_DOWN, TOOL_LOOP_LIMIT, INTERNAL` |

Exactly one of `done`/`refusal`/`error` ends a generation. The conversation lock and user slot are released **before** the terminal event is appended (AS-31). Only `done` persists the turn, in one batch, before the event.

## Resume rules

- `Last-Event-ID` absent → replay from `meta`. Present and valid → first event is the next one after it, each later event exactly once. Newer than newest → empty replay, then live.
- Malformed → `400 invalid_last_event_id`. Unknown, expired or foreign → `404`.
- A finished generation stays replayable for `assistant_replay_window_ms` (15 min). A resume after the terminal id returns an empty, immediately-ended stream.
- A viewer counts as attached while it polls (presence TTL 5 s), including on another instance. No viewer for `assistant_detach_grace_ms` (10 s) → abort, `error CANCELLED`.
- Generator without liveness for more than 10 s → exactly one `error GENERATION_LOST`.
