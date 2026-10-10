# Data model: S51 — Realtime push hub

No SQL table, no ORM model (`check:table-ownership`: 0 findings expected for `infrastructure/realtime`). State lives in the shared store under the prefix `rt:` (I.4), plus in-memory structures per gateway instance.

## Store keys (owned by this lib)

| Key | Type | Content | Bound / TTL |
|---|---|---|---|
| `rt:s:<topic>` | stream | fields `t` (type), `d` (JSON payload ≤ 32 KiB); entry id = topic position | `MAXLEN ~ 1000` (≤ 1,200), `MINID ~ now-1h`, `PEXPIRE` 1 h refreshed on each publish |
| `rt:c:<topic>` | pub/sub channel | JSON `{id, topic, type, data}`; `id` = `0-0` for live-only | not stored |
| `rt:ctl` | pub/sub channel | JSON `{userId?, prefix, id, suffix?}` revocation notice | not stored |

## Cursor
`<topic>~<position>` entries joined by `|`; position `^\d{1,16}-\d{1,16}$`, not `0-0`, not > 1 min in the future; header ≤ 2,048 chars. Zod `cursorSchema` in `packages/contracts`.

## In-memory (per instance), all bounded and released on close
- `Hub.channels: Map<channel, {listeners:Set<Listener>, ready:Promise<void>}>` — one entry per channel with ≥ 1 listener.
- `Connection { id, principal: {kind, userId?}, topics: Map<topic, TopicState>, cursor: Map<topic, position>, replayBuffer (≤ 1,000), timers {heartbeat, lifetime, stall, drain}, closed }`.
- `TopicState = admitting | active | revoked` (state machine: `admitting → active → revoked`; a notice during `admitting` moves it to `revoked` after the rule returns).
- Counters for caps: `byUser: Map<userId, n>`, `byAddress: Map<addr, n>`, `total`.
- `TopicRegistry.routes: Map<'prefix' | 'prefix:suffix', {policy, owner}>`; frozen on application start.

## Typed surface
`RealtimeTopicPrefixes` (augmentable interface) → `RealtimeTopic` template-literal type; `topicOf` builders per domain. Errors: `InvalidRealtimeTopicError`, `InvalidRealtimeEventTypeError`, `RealtimePayloadTooLargeError`, `InvalidRealtimePayloadError`, `RealtimeUnavailableError`, `TopicRegistryFrozenError`.

## Rate policy
`realtime.connect`: sliding window, 60/min, key user-or-address, fail open (declared via `RateLimitModule.forFeature`).
