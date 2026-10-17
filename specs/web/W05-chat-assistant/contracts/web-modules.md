# Web modules provided by W05 (exact names)

| Module | Exports |
|---|---|
| `app/chat/page.tsx` (Server) | default page: `searchParams` + `requireServerSession(returnTo)` inside `<Suspense>`; hydrates `chat.inbox` |
| `lib/chat/links.ts` | `chatHref(target: { product: string } \| { channel: string } \| Record<string, never>): string` |
| `lib/query-keys.ts` | `queryKeys.chat.{all, inbox(), unreadTotal(), channel(id), byProduct(id), messages(id), receipts(id), presence(userId)}`, `queryKeys.assistant.{all, conversations(), history(id), usage()}` (replace `chat.channels`, `chat.messages`) |
| `lib/api/chat.ts` | `chatApi.{inbox, unreadPage, channel, byProduct, create, join, history, send, sync, markRead, remove, receipts, heartbeat, presence}`; `send({channelId, clientMessageId, body, replyToId?})` returns `{message, duplicate}`; typed problems with extension members; no `mergeMessages` |
| `lib/api/assistant.ts` | `assistantApi.{listConversations, createConversation, deleteConversation, history, send, resume, cancel, usage}`; `send`/`resume` deliver typed events via a callback/async iterator; `Idempotency-Key`, `Last-Event-ID`; no token |
| `lib/chat/catch-up.ts` | `mergeMessages`, `createCatchUp` (single flight + one trailing run, `hasMore` loop, cursor-ahead reset) |
| `lib/chat/pending-messages.ts` | pending-message reducer and `newClientMessageId()` |
| `lib/chat/{composer-rules,read-position,receipts,errors-copy}.ts` | pure helpers (code-point limit, read debounce/ack rules, `seenBy`, copy tables for AS-05/18/19) |
| `lib/assistant/reply-reducer.ts` | `replyReducer`, `initialReply`, phase types |
| `lib/assistant/{problem-copy,resume-schedule,tool-labels,active-store}.ts` | copy catalogues AS-56..59, schedule `[0,1,2,4,8]s then 10s up to 120s`, chip labels, per-tab pointer |
| `lib/realtime/chat-topics.ts` | `selectTopics(openId, items)` (open + 8 latest) over `subscribeTopic` |
| `components/assistant/assistant-launcher.tsx` | `<AssistantLauncher variant="icon" \| "menu-item" />` (owns trigger + sheet) |
| `components/chat/chat-nav-badge.tsx` | `<ChatNavBadge />`, `useChatUnreadTotal(): number \| null` |
| `tests/helpers.ts` | `openAssistant(page)`, `askAssistant(page, text)`, `openProductChat(page, productId)` |

Stable `data-testid`s kept (LOCAL): `chat-title`, `chat-message`, `chat-channel`, `assistant-message`, `user-message`.

Deleted: `app/chat/chat-view.tsx`, `hooks/use-event-stream.ts`, `lib/api/sse.ts`, `components/chat/assistant-launcher.tsx` (stand-in), `toggle-assistant` dispatch.
