# Gaps: current code vs W05 spec

Files in scope: `packages/web/app/chat/{page,chat-view}.tsx`, `components/assistant/{assistant-sheet,chat-interface,chat-message}.tsx`, `hooks/{use-assistant-chat,use-event-stream}.ts`, `lib/api/{chat,assistant,sse,sse-reader,client}.ts`, `lib/query-keys.ts`, `components/layout/navbar.tsx` (W07's frame, W05's launcher), `app/layout.tsx`, `app/products/[slug]/page.tsx:99` (the link), `next.config.ts`, `tests/{chat,assistant,helpers}.ts`, `vitest.config.ts`, `playwright.config.ts`. This is the implementation agent's to-do list; each row names the spec items it satisfies. The code is a draft; nothing here is a regression of something that worked as specified.

## A. Data flow and constitution VI

| # | Gap | Where | Spec |
|---|---|---|---|
| A1 | The whole chat page is one client component with server data in `useState` (`channels`, `unread`, `messages`, cursors in a ref); no TanStack Query, no URL state, no server guard | `app/chat/chat-view.tsx:36-44` | FR-010, FR-011, FR-070, AS-68, AS-69 |
| A2 | The guard is a client effect that redirects to `/login?returnUrl=%2Fchat` (wrong parameter name since W01, drops `?product=`) | `chat-view.tsx:46-48` | FR-002, AS-06 |
| A3 | `/chat` page wraps a client view in `<Suspense>` to read `useSearchParams`; no server session read, no first inbox read on the server | `app/chat/page.tsx:1-10` | FR-002, AS-69 |
| A4 | A component calls the catalogue API directly (`apiClient.get('/api/products/:id')`) to decide authority | `chat-view.tsx:25` | FR-014, AS-04, VI.3 |
| A5 | Network calls from a component (`apiClient`) and hooks (`streamSse`, `EventSource` through `createEventStream`) outside `lib/api` rules | `chat-view.tsx:12,25`, `hooks/use-event-stream.ts`, `lib/api/sse.ts:6-9` | FR-050, AS-67 |
| A6 | Responses typed by hand (`ChatChannel`, `ChatMessage`, `ChannelSync`, `Conversation`, `AssistantHistoryMessage`), none parsed with contract schemas (`packages/contracts` has no source) | `lib/api/chat.ts:9-33`, `lib/api/assistant.ts:4-15` | FR-072, AS-70 |
| A7 | Bearer token read from JavaScript and sent with each stream request; absolute cross-origin base for the live stream (`NEXT_PUBLIC_SSE_URL`, default `http://localhost:3000`) | `lib/api/sse-reader.ts:1,51-59`, `lib/api/sse.ts:6-9`, `lib/api/client.ts:3,13-24` | AS-67, FR-050 (W01 removes the token; this capability must not re-add it) |
| A8 | Query keys `chat.channels` / `chat.messages` exist but nothing uses them; no assistant keys | `lib/query-keys.ts:14-17` | FR-070 |
| A9 | Global 60 s stale time applies to everything | `lib/providers.tsx:15-18` | FR-073 |
| A10 | `mergeMessages` lives in the API client | `lib/api/chat.ts:35-42` | AS-25 (`lib/chat/catch-up.ts`) |
| A11 | Assistant state (messages, ids, abort controller) in `useState`/refs inside one hook; conversation not listable, not resumable | `hooks/use-assistant-chat.ts:23-30` | FR-053, FR-058, AS-48, AS-61 |

## B. Chat: opening, inbox, conversation

| # | Gap | Where | Spec |
|---|---|---|---|
| B1 | The chat is created silently on navigation when `product.sellerId === user.id`; the explicit button, `403`/`409` handling and role gating do not exist | `chat-view.tsx:19-31` | AS-03, AS-04 |
| B2 | Buyers are joined without a visible state ("Opening chat…"), no refusal copy for invalid link / archived / banned / `429` / `5xx`; every failure is a toast | `chat-view.tsx:55-67` | AS-01, AS-05 |
| B3 | `?product=` stays in the address; the selected chat is `useState` (reload and Back lose it) | `chat-view.tsx:41,63` | FR-001, AS-01 |
| B4 | Inbox = `GET /chat/unread` (bare array assumption) + one `GET /chat/channels/:id` per row (N+1); no pagination; no `lastMessageAt`, no archived tag, no order | `chat-view.tsx:57-58`, `lib/api/chat.ts:44-46` | AS-07, AS-09, FR-010; backend M1 |
| B5 | Inbox rows are buttons (no URL), no `aria-current`, badge without accessible name, no loading/error/empty-after-failure states | `chat-view.tsx:139-156` | AS-07, AS-08, AS-39 |
| B6 | No refresh of the inbox after the first load (badges only change for the open chat) | `chat-view.tsx:54-70` | AS-10 |
| B7 | Messages come only from `sync` with cursor 0: first 200 oldest messages, `hasMore` ignored, no history endpoint, no scroll-back | `chat-view.tsx:72-83`, `lib/api/chat.ts` (no `history`) | AS-12, AS-13 |
| B8 | No unread divider, no jump pill; `scrollIntoView({behavior:'smooth'})` on every change, even when the reader scrolled up | `chat-view.tsx:102-104` | AS-12, AS-32 |
| B9 | Message list is a `div`, no role/name; no day separators, no message actions (delete, reply); tombstone text "message removed" lower case | `chat-view.tsx:161-170` | AS-20, AS-21, AS-22, AS-39 |
| B10 | Layout: fixed two-pane `flex gap-4` with `h-[calc(100vh-4rem)]` and a `w-72` sidebar at every width — on a phone the conversation is squeezed or unreachable; no master/detail, no Back link | `chat-view.tsx:128-129` | AS-37, AS-38 |
| B11 | Author label for other members is "Buyer {4}"; "Seller" only for the creator (spec keeps this; see backend M4) | `chat-view.tsx:124` | AS-22 |
| B12 | No unread total component for the navbar | — | AS-11 |
| B13 | Loading/guard state is a bare `div` "Loading chat…" with no `role="status"` | `app/chat/page.tsx:7`, `chat-view.tsx:121` | AS-08, AS-12 |

## C. Chat: sending, read marking, presence

| # | Gap | Where | Spec |
|---|---|---|---|
| C1 | `clientMessageId` is generated inside `chatApi.send` on every call, so a caller retry creates a duplicate | `lib/api/chat.ts:48-49` | FR-026, AS-16 |
| C2 | No optimistic bubble, no "Sending…"/"Not sent", no Retry/Discard, no auto-retry; a failed send is a toast and the text stays | `chat-view.tsx:107-120` | AS-14, AS-16, AS-17 |
| C3 | Single-line `Input` (no newline), Enter via form submit, no IME guard, no code-point counter, `maxLength` counts UTF-16 units; Send has `aria-label="Send"` (spec: "Send message") | `chat-view.tsx:176-179` | AS-15 |
| C4 | No handling of `banned`, `muted` (+`mutedUntil`), `channel_archived`, `reply_target_invalid`, `429`; the composer is never disabled by chat state; `isArchived` is fetched and ignored | `chat-view.tsx:113-120`, `lib/api/chat.ts:11-16` | AS-18, AS-19 |
| C5 | No delete-message, no reply, no tombstone flow for others' deletions (sync does not redeliver deletions; no history refresh) | — | AS-20, AS-21 |
| C6 | `markRead` fires on every change of the last message regardless of tab visibility, scroll position or focus, ignores the response, and zeroes the badge locally | `chat-view.tsx:96-100` | FR-046, AS-31, AS-32, AS-36 |
| C7 | No heartbeat, no presence read, no receipts, no "Seen by" | — | AS-33, AS-34, AS-35 |
| C8 | `markRead` returns `void`; `send` returns `{message}` only (drops `duplicate`) | `lib/api/chat.ts:48-53` | FR-027, AS-31 |

## D. Realtime and reconnect

| # | Gap | Where | Spec |
|---|---|---|---|
| D1 | Fixed 3 s polling of all channels forever (also in a background tab, also offline), failures swallowed with `.catch(() => undefined)`; no banner | `chat-view.tsx:16,86-90` | AS-23, AS-24, AS-29 |
| D2 | `createEventStream` does not handle `resync` or `revoked` (the listener list must name every type), `onerror` only logs, a permanently closed stream is never recreated; `useEventStream` keys its effect on `topics.join(',')` and an unstable callback; nothing in chat uses it | `lib/api/sse.ts:10-31`, `hooks/use-event-stream.ts:11-18` | FR-040–FR-043, AS-26, AS-27, AS-28 |
| D3 | Each page would open its own `EventSource`; W03's shared connection manager does not exist yet | `lib/api/sse.ts` | FR-045 (W03 contract) |
| D4 | No catch-up routine (single flight, `hasMore` loop, cursor-ahead reset, merge by id) | `chat-view.tsx:72-83`, `lib/api/chat.ts:35-42` | FR-041, AS-25, AS-30 |
| D5 | No online/offline, visibility handling | — | AS-29 |

## E. Assistant

| # | Gap | Where | Spec |
|---|---|---|---|
| E1 | The sheet is mounted in the root layout for every page and opened by a `window` custom event dispatched from the navbar | `app/layout.tsx:40`, `components/layout/navbar.tsx:35-37,104`, `components/assistant/assistant-sheet.tsx:10-15` | FR-004, AS-41 (`<AssistantLauncher />`, W07 mounts) |
| E2 | Sends without `Idempotency-Key` (S46 now answers `422 idempotency_key_required`) | `hooks/use-assistant-chat.ts:39`, `lib/api/sse-reader.ts:48-62` | FR-050, AS-45 |
| E3 | No resume: a dropped stream just ends (`streamSse` resolves when the reader ends), no `Last-Event-ID`, no re-attach, no reload recovery, no pointer | `hooks/use-assistant-chat.ts:39-56`, `lib/api/assistant.ts` (no `resume`) | FR-052, AS-49, AS-50, AS-51 |
| E4 | Stop aborts the local fetch first, then calls cancel with `.catch(() => undefined)`; no "Stopping…", no `409/404` handling, no history fallback, button named only by `title` | `use-assistant-chat.ts:65-70`, `chat-interface.tsx:80-90` | FR-054, AS-52 |
| E5 | `error`/`refusal` events become `toast.error(data.message ?? …)` (the stream has no `message`); `refusal` does not replace streamed text; HTTP errors collapse to three strings (`429` always "Rate limit exceeded") | `use-assistant-chat.ts:52-57` | AS-56, AS-57, AS-58, AS-59 |
| E6 | Tool chips keyed by name (one chip per tool name even when a tool runs twice), status vocabulary `pending/success/error` instead of `running/done/failed`, keyed by array index, label from the raw name | `use-assistant-chat.ts:47-51`, `components/assistant/chat-message.tsx:41-52` | AS-43 |
| E7 | User bubble ids `user-${Date.now()}` and `key={message.id \|\| i}` | `use-assistant-chat.ts:32`, `chat-interface.tsx:56` | VI.6, AS-42 |
| E8 | Markdown rendered with `react-markdown` + `remark-gfm` without link rules (no `rel`, any scheme link) | `chat-message.tsx:73-75` | AS-44 |
| E9 | No conversation list, no new chat, no delete, no history load, no pointer; every page load starts blank | `use-assistant-chat.ts:30,38` | AS-48, AS-61–AS-64 |
| E10 | No allowance meter or usage read; no quota disabled state | — | AS-47, AS-59 |
| E11 | No location switch (the backend takes `lat/lng`) | — | AS-46 |
| E12 | Transcript is a Radix `ScrollArea` with `scrollTop` manipulation by `querySelector('[data-radix-scroll-area-viewport]')`; no `role="log"`, no announcements, no "Answer ready"; Send button has no accessible name; textarea has no label; `Square` button only a `title`; sheet has no `SheetDescription` | `chat-interface.tsx:18-25,66-100`, `assistant-sheet.tsx:19-28` | AS-66 |
| E13 | Anonymous state is a bare "Log in" link to `/login` without `returnTo` | `chat-interface.tsx:44-50` | AS-41 |
| E14 | Session-ended (`401`) shows "Log in to use the assistant." toast only for the send; resume/cancel/history have no handling | `use-assistant-chat.ts:56` | AS-60 |
| E15 | Sheet width `sm:max-w-md`, `w-full` on mobile: acceptable, but height uses `h-full` (not dynamic viewport) so the mobile keyboard can cover the composer | `assistant-sheet.tsx:18` | AS-65 |

## F. Tests and tooling

| # | Gap | Spec |
|---|---|---|
| T1 | React Testing Library, `@testing-library/user-event`, `@testing-library/jest-dom`, `msw` (and `@axe-core/playwright`) are not installed; no Vitest setup file (jest-dom matchers, MSW server, `EventSource`/`ReadableStream` fakes, `matchMedia`, `IntersectionObserver`, `ResizeObserver`, `scrollIntoView` stubs) | test-plan conventions |
| T2 | `vitest.config.ts` `include` covers only `lib/**/*.test.ts` and `hooks/**/*.test.ts`; add `components/**/*.test.tsx`, `app/**/*.test.tsx`, `lib/**/*.test.tsx`, `hooks/**/*.test.tsx`; environment `jsdom` is already set; add `setupFiles` and `css: false` | test-plan |
| T3 | No `tests/visual/` folder or screenshot baselines; `playwright.config.ts` has only the `chromium` project, no `mobile` project (390 × 800), no `expect.toHaveScreenshot` settings, no `page.route` stub helpers | AS-37, AS-38, AS-65 |
| T4 | `tests/chat.spec.ts` and `tests/assistant.spec.ts` use `getByTestId('chat-title' \| 'chat-message')`, `getByLabel('Message')`, button name `Send` (becomes "Send message"), and the placeholder; rewrite to the new flow (join from product page, "Open chat for this product", unread badge, "Seen"), keep `data-testid` hooks (LOCAL), add the reload test (AS-48) | test-plan JC, JA |
| T5 | `tests/helpers.ts` `login(..., returnUrl)` becomes `returnTo` with W01; add `openAssistant`, `askAssistant`, `openProductChat` (spec *Provides*) | W01 helpers, spec Provides |
| T6 | `lib/api/chat.test.ts` tests `mergeMessages` from the API client; move to `lib/chat/catch-up.test.ts` and write the client tests (relative URLs, schema parsing, one `clientMessageId` per action) | UA9, UC9 |
| T7 | `lib/api/sse-reader.test.ts` covers the parser only; add the reader's reconnect/resume tests through `hooks/use-assistant-chat.test.tsx` and fakes that deliver chunks with drops | UA5, UA8 |
| T8 | `lib/architecture.test.ts` (shared with W03) does not exist | AR (AS-67–AS-69) |
| T9 | `packages/contracts` has no source: the schemas named in the spec must exist before the clients can parse | FR-072 |
| T10 | No fake for the scripted slow reply in journeys; the reload/stop/resume journeys are therefore unit tests. If S46's scripted provider gains a "slow" trigger text, add a JA journey for AS-50 | test-plan note |
| T11 | An `AssistantLauncher` journey needs W07's navbar mount; until W07 lands, mount it temporarily in `components/layout/navbar.tsx` in place of the event dispatch | AS-41 |

## G. Missing backend endpoints and contract asks

| # | Needed | Owner | Why |
|---|---|---|---|
| M1 | `GET /chat/channels/mine?limit&cursor` → `{items: (chatChannel & {unread, lastSeq, lastMessageAt})[], nextCursor}` | **S24** (single-domain read, no BFF aggregate needed: one owner, IX.7 R2 not triggered) | the inbox needs titles, last time, archived chats and unread in one call; today N+1 |
| M2 | Hub events `message`, `message_deleted`, `channel_archived` on `chat:<id>` (`replay: false`) | **S24** (with S51's `RealtimePublisher`) | live hints for the stream hub; today messages go only to the gateway bus |
| M3 | `GET /chat/channels/:id/receipts` → `{items: {userId, lastReadSeq}[], suppressed}` | **S24** | starting positions for "Seen by"; events alone only cover readers after the page opened |
| M4 | Optional `authorIsShopStaff` on messages | **S24** | "Seller" label for staff other than the creator |
| M5 | Assistant history `id` equals stream `meta.messageId` | **S46** | AS-51 history fallback |
| M6 | Authenticated, unbuffered, uncompressed forwarding of `/api/chat/*`, `/api/assistant/*` (POST and GET event streams) and `/api/streams`; change the rewrites that bypass the BFF (`/api/assistant/:path*`, `/api/streams`) | **S48** + W01/W07 (`next.config.ts:26-28`) | no token in JavaScript (VI.2) |
| M7 | Problem extension members exposed uniformly (`mutedUntil`, `used`, `limit`, `resetsAt`, `messageId`, `category`) and `Retry-After` readable by the browser | S24, S46, S50 | exact copy in AS-18, AS-56, AS-59 |
| M8 | `chatChannelSchema` etc. and the S46 schemas in `packages/contracts` | S24, S46 | FR-072 |

## H. Cross-capability work to coordinate

- **W03**: ship `subscribeTopics` / `useStreamStatus` on the shared connection (or W05 builds `lib/realtime/chat-stream.ts`, FR-045).
- **W07**: mount `<AssistantLauncher />` in the navbar and mobile menu; delete `toggle-assistant` dispatch (`navbar.tsx:35-37,104`) and `<AssistantSheet />` (`app/layout.tsx:8,40`); optionally mount `<ChatNavBadge />`.
- **W01**: `problemFromError`, `<ProblemAlert />`, `useAuth().status`, session-ended flow, `requireServerSession`, `BroadcastChannel('auth')`; remove `getAccessToken()` use from `streamSse`.
- **W02**: `productHref(productId)` for **View product** / **Back to product**; the product page link keeps `/chat?product=<id>` (`app/products/[slug]/page.tsx:99` becomes `chatHref({product})`).
- **W04**: may link seller product rows to `chatHref({product})`.

## Suggested order

1. Tooling (T1–T3, T9), contracts (M8), `lib/query-keys.ts` (A8), `lib/api/chat.ts` and `lib/api/assistant.ts` with schema parsing (A6, C1, C8).
2. Chat core: server page + guard + URL state (A1–A3, B3), resolver (B1, B2), inbox (B4–B6, M1), conversation with history (B7–B9), composer and pending messages (C1–C5).
3. Realtime: catch-up (D4), connection (D2, D3, D5), read tracker and presence (C6, C7).
4. Assistant: launcher (E1, E13), reducer and send with key (E2, E7), resume and stop (E3, E4), errors (E5, E14), chips and markdown (E6, E8), conversations and usage (E9–E11), a11y and layout (E12, E15).
5. Layout and visual suite (B10, T3), journeys (T4, T5), architecture test (T8).
