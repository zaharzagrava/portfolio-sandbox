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

## Tooling check (T001, 2026-10-17)

Read: `packages/web/AGENTS.md` and the guides *Authentication with Cache Components*, *Rendering philosophy*, *Building interactive apps*, *Forms / Server Actions* and `instant` (`node_modules/next/dist/docs/01-app/...`). What they fix for W05: request reads (`cookies()`, `searchParams`, the session) only inside `<Suspense>`; no `use cache` for member data; `requireServerSession` is a convenience (every API call authorises again); the static shell (frame, skeletons) is prerendered and the data streams in behind the boundary.

Installed and working (gaps T1, T2 closed): `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `msw` (shared `server` in `vitest.setup.ts`, unhandled requests fail), `@axe-core/playwright` (`tests/visual/axe.ts`), `react-virtuoso`, `react-markdown`. `vitest.config.ts` already includes `components/ app/ lib/ hooks/` `*.test.{ts,tsx}` and runs `vitest.setup.ts` (jest-dom, MSW, `matchMedia`, `IntersectionObserver`, `ResizeObserver`, `BroadcastChannel`, `scrollIntoView`, geolocation and clipboard stubs). `lib/test/event-source-stub.ts` and `lib/test/stub-registry.ts` exist.

Missing, added by T002/T003: the chunked fake response and the fake live connection (`tests/support/chunked-stream.ts`: `sseFrame`, `chunkedResponse`, `controlledStream`, `problemResponse`; `tests/support/fake-live.ts`: `createFakeLive`, a stand-in for `subscribeTopic`; proven by `lib/test/w05-support.test.ts`) and the visual stub helpers (`tests/visual/stubs.ts`: `stubApi`, `problem`, `stubEventStream`, `frame`, `stubHubStream`, `setOffline`). `fast-check` is not installed and not added (no new dependency): the SC-001 property test uses a seeded pseudo-random generator.

Deviation (T003): the existing `mobile` Playwright project is 390 x 844 (W02/W04 baselines depend on it) and `expect.toHaveScreenshot` already has `animations: 'disabled'`. Not changed; the W05 visual specs set `test.use({ viewport: { width: 390, height: 800 } })` themselves.

Deviation (T004): the comment above the catch-all rewrite in `next.config.ts` (lines 46-49) was re-read against `rewrites.test.ts` and the forwarder's `route-table.ts`; it describes the current routing correctly (the forwarder, not the web rewrites, sends `/api/streams`, `/api/live/:id/events` and `/api/assistant/*` to the SSE origin), so it was kept.

## Sibling-spec follow-ups

- **S48**: the forwarder (`packages/backend/libs/composition/bff/forward/forward.controller.ts`) streams request and response unbuffered (`answer.pipe(res)`, `no-store, no-transform` on event streams) and passes `Last-Event-ID`, `Idempotency-Key` and `Retry-After`, but its `RESPONSE_HEADERS` allow-list has `idempotency-replayed` and not `Idempotent-Replay`, the header S46 sets on a replayed turn (`assistant.controller.ts:133`). The browser never sees it. W05 does not depend on it (a replayed finished turn is rendered from its events once, AS-54), but the forwarder should pass `idempotent-replay` too.
- **W07**: `components/layout/navbar.tsx` has no slot for `<ChatNavBadge />` (W07's gaps record it as "not mounted"; the desktop header has no Chats entry at all, only the mobile menu has one). W05 ships `ChatNavBadge` and `useChatUnreadTotal()` at `components/chat/chat-nav-badge.tsx` (member-only data: nothing rendered and no request for an anonymous visitor); W07 must add a Chats link for members in the header (and the mobile menu entry) and mount the badge inside it.
- **S24**: W05 built the three provider-side asks it needed, documented as R-29 (`GET /chat/channels/mine`), R-30 (`GET /chat/channels/:id/receipts`) and R-31 (hub events `message`, `message_deleted`, `channel_archived` on `chat:<id>`, `replay: false`) in `docs/spec/capabilities/S24-product-chat.md`; S24's own spec should adopt them. M4 (`authorIsShopStaff` on messages) is not built: the "Seller" label stays creator-only until S24 adds it.
- **W04**: seller product rows may link to the chat of a product through `chatHref({product})` from `lib/chat/links.ts`; nothing in W04 has to change for W05 to work.

## Gate repairs

- `JC-2 cart checkout` failed again in the full run (both projects; cart "Subtotal" never shown, then "Order confirmed" never shown). Environment fault, not a product defect: `/var/log/sdd/api.log` shows `502 bad_gateway … socket hang up` on `/api/bff/f/cart`, `/streams` and `/notifications/unread-count` in the same minutes (the web dev server stalled under the loaded run). `stack-fix.sh smoke` reports the stack healthy; W05 changes do not touch the cart (only the navbar import of `AssistantLauncher` and the `chatHref` link). `tests/cart-checkout.spec.ts` passes 10/10 in both projects, and JC-2 alone passes in both. No test or code changed.
- Repeat of the same failure (2026-10-18): `stack-fix.sh smoke` ok; `/api/bff/cart` answered `502 bad_gateway` / `503 upstream_unavailable` ("The service could not be reached") at several moments of the gate run, which is the watch-mode API restarting under the run, not a defect. Re-run: JC-2 passes in both projects, and the whole `tests/cart-checkout.spec.ts` passes 10/10 (47.8 s). No test or code changed.

- AS-65 had no test titled with its ID. Added `W05 AS-65` to `packages/web/tests/visual/assistant.visual.spec.ts`: the sheet is full screen at 390 px and a right panel at 1280 px, the composer is inside the viewport, and the page has no horizontal scroll. It passes in both projects.
- Gate run with 6 failures, none a product defect. `tests/visual/chat.visual.spec.ts` ("not sent" and "muted" shots): the virtualised list rests a few pixels apart between runs, so those two checkpoints now pin the list to its end (`pinToEnd`) before the shot, and both mobile baselines were regenerated. `W07 AS-23 VN privacy page` (both projects): the page lists the browser-storage inventory and W05 added `assistant.active` and `assistant.sheetOpen`, so its baseline was regenerated (intended change; W07 owns the test). `JC-2 cart checkout` and `Notifications open` timed out only under the loaded full run and pass on rerun.

- 2026-10-18, gate failure `tests/cart-checkout.spec.ts` JC-2 (mobile and desktop: `Subtotal (` not found, then `Order confirmed` not shown): not caused by W05. `stack-fix.sh smoke` reported the environment fine; the spec touches no W05 file (cart, checkout, payment code is unchanged). Re-run alone with `--project=mobile --project=desktop`: 10 of 10 passed (JC-2 in 21 s on desktop). Diagnosis: a timing failure under load in the full run (dev-server first-compile of `/cart` and `/checkout` plus API watch restarts during the 5.2 min run). No code or test changed.
- 2026-10-18, second JC-2 gate failure (only `Order confirmed` missing; the page snapshot shows a signed-out shell). `stack-fix.sh smoke`: environment ok. Re-run: JC-2 alone passed on both projects, and the whole `cart-checkout.spec.ts` passed 10 of 10. The API log shows a burst of `401 invalid_token` for two users at the same second (`/api/payments`, `/api/notifications/unread-count`, `/api/bff/seller/...`, 22:47:21), so the session was invalidated mid-run by something in the loaded full run, not by cart, checkout or W05 code. No test searches for key rotation; the cause of that burst is not identified. No code or test changed.
