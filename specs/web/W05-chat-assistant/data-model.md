# Data Model: W05

No new tables. Entities are client view models over the contracts in `packages/contracts` (`chat/*`, `assistant/*`) plus the three additive S24 reads.

## State homes (constitution VI.4)

| Data | Home | Key / place |
|---|---|---|
| Inbox pages | TanStack Query (infinite) | `queryKeys.chat.inbox()` |
| Unread total (navbar) | TanStack Query | `queryKeys.chat.unreadTotal()` |
| Open chat fields (`myRole`, `isArchived`, `sellerId`, `productId`, `title`) | TanStack Query | `queryKeys.chat.channel(id)` |
| Product → chat lookup | TanStack Query | `queryKeys.chat.byProduct(productId)` |
| History + synced messages | TanStack Query (infinite, merged by `id`) | `queryKeys.chat.messages(id)` |
| Receipt positions | TanStack Query | `queryKeys.chat.receipts(id)` |
| Seller presence | TanStack Query | `queryKeys.chat.presence(userId)` |
| Conversations / history / usage | TanStack Query | `queryKeys.assistant.{conversations,history(id),usage}()` |
| Which chat is open | URL | `?channel=<uuid>` (`?product=` one-shot, replaced) |
| Draft per chat, reply target, pending bubbles, scroll anchor | local state (`useReducer`/`useRef`) in `conversation` / `chat-shell` | memory only |
| Reply (phase, text, chips, ids) | `useReducer` in `use-assistant-chat` | memory |
| Location switch + coordinates | `useState` in the assistant composer | memory only |
| Open sheet | `useState` in `AssistantLauncher` (+ flag below) | |
| Remembered assistant state | `sessionStorage` (per tab) | `assistant.active`, `assistant.sheetOpen` |

No Context, no store.

## Entities

**InboxRow** = `chatChannel & {unread: number, lastSeq: number, lastMessageAt: string | null}`; derived: `unreadLabel` (`99+`), sort (active first, newest first), `isOpen`.

**ChatMessage** (contract): `id, seq, authorId, body | null, replyToId | null, createdAt, deleted`. Ordering by `seq`; merge by `id` (incoming replaces held).

**PendingMessage**: `{ clientMessageId: uuid, body: string, replyToId: string | null, state: 'sending' | 'failed', failure?: 'network' | 'refused', reason?: 'reply_target_invalid' | 'validation_failed' | 'rate_limited' | …, retryAfterAt?: number }`. Terminal transition `confirmed` removes it (message goes to the cache). Never persisted.

State transitions (FR-027):

```text
(submit) → sending → confirmed (201/200)          [removed from pending, message in cache]
sending → failed(network) → sending (Retry | auto once per reconnect) | discarded
sending → failed(refused) → sending (Retry, same id) | discarded | sending (new id, no reply ref, reply_target_invalid)
```

**ConnectionView**: `'connected' | 'reconnecting' | 'offline'` derived from `getUserStreamSnapshot().health` and `useOnline()`; banner shown after 3 s of not-connected.

**CatchUpState** (module): `{ running, rerun }` single-flight; per-chat cursor = highest `seq` held.

**ReadPosition** (per chat, ref): `{ acknowledged, pending, timer, blockedUntil }`.

**ReceiptsView**: `Map<userId, lastReadSeq>` (others only) from `read` events + receipts endpoint; `seenBy(message) = count(pos >= message.seq)`; absent data → no label.

**AssistantReply** (reducer state):

```ts
{ phase: 'idle'|'sending'|'streaming'|'reconnecting'|'stopping'|'ended',
  outcome?: 'done'|'refused'|'error'|'stopped'|'lost',
  messageId?: string, lastEventId?: string,
  text: string, tools: {id, name, status:'running'|'done'|'failed'}[],
  errorCode?: string, retryAfterMs?: number, question: string, idempotencyKey: string }
```

Transitions (FR-053; anything else is ignored by the reducer):

```text
idle --send--> sending --meta--> streaming --text/tool--> streaming
streaming --connectionLost--> reconnecting --resumed--> streaming
sending|streaming|reconnecting --done|refusal|error--> ended(outcome)
streaming|reconnecting --stopRequested--> stopping --error CANCELLED--> ended(stopped)
stopping --409 generation_finished--> (history read) ended(done)
reconnecting --all attempts failed (2 min)--> ended(lost)
ended --reset|send--> idle|sending
```

First terminal event is final; `text` after terminal ignored; non-increasing event id ignored; a second `meta` (replay) resets text and chips.

**RememberedAssistantState** (FR-071): `{ conversationId, messageId?, pendingText?, idempotencyKey? }` + `sheetOpen: boolean`; removed on reply end (message/pending/key), conversation delete, sign-out.

**InboxPage / ConversationList / Usage**: contract shapes (`{items, nextCursor}`; usage `{used, limit, resetsAt}`; meter = `min(100, floor(used / limit * 100))`, none when `limit <= 0`).

## Validation rules (client)

- Composer: trim; non-empty after trim; ≤ 4,000 **code points** (cut at limit on type/paste); counter from 3,500.
- Assistant composer: same limit; one `Idempotency-Key` per user action, reused when the same unsent text is re-sent, new key when the text changes or after `idempotency_key_reuse`.
- `channel` / `product` query values must be UUIDs, otherwise the unavailable / invalid-link state without a request (FR-001).
- Every response parsed with its contract schema; mismatch → unexpected-error copy.
