# Tasks: W05 — Product chat and the streamed shopping assistant sheet

**Input**: `specs/web/W05-chat-assistant/` (plan.md, spec.md, test-plan.md, gaps.md, questions.md, research.md, data-model.md, contracts/, quickstart.md)

**Order**: test-first. For each test-plan row the failing test task precedes its code task. Runtime proofs (fresh-stack run, full journey/visual run, standalone boots, `next build`) are deferred to the final checkpoint and are not tasks here. Never use git checkout/restore/reset/stash/clean. All `packages/web` paths are written relative to the repo root.

## Format: `- [ ] Txxx [P?] [USn?] Description with path`

## Phase 1: Setup (plan Phase 0)

- [X] T001 Read `packages/web/AGENTS.md` and the guides *Authentication with Cache Components*, *Rendering philosophy*, *Building interactive apps*, *Server Functions/forms*, `instant` in `packages/web/node_modules/next/dist/docs/`; confirm the already-installed tooling (RTL, user-event, jest-dom, msw, @axe-core/playwright, `vitest.config.ts` include and setupFiles); note anything missing under 'Tooling check' in `specs/web/W05-chat-assistant/gaps.md` (gaps T1–T2)
- [X] T002 Only if missing: widen `packages/web/vitest.config.ts` `include` to `components/ app/ lib/ hooks/` `*.test.ts(x)`; add stubs (`matchMedia`, `IntersectionObserver`, `ResizeObserver`, `scrollIntoView`) to the Vitest setup file; add a chunked fake `ReadableStream` response helper and a fake live-connection helper in `packages/web/tests/support/` (gaps T1, T2, T7)
- [X] T003 [P] Add a Playwright `mobile` project (390×800) and `toHaveScreenshot` settings (animations disabled) to `packages/web/playwright.config.ts`; create `packages/web/tests/visual/stubs.ts` with `page.route` stub helpers (gap T3)
- [X] T004 [P] Verify the BFF forwarder passes `/api/chat/*`, `/api/assistant/*` (POST and GET event streams) and `/api/streams` unbuffered, with `Idempotent-Replay`/`Last-Event-ID` passed through and `Retry-After` readable: read `packages/web/lib/api/rewrites.test.ts` and `packages/web/next.config.ts`; delete the stale comment at `next.config.ts:47-48`; if buffering is found add a bullet for **S48** under '## Sibling-spec follow-ups' in gaps.md (gaps M6, M7)
- [X] T005 Write failing architecture rules in `packages/web/lib/architecture.test.ts` (extend the shared file): no `fetch`/`axios`/`EventSource` in `components/` or `hooks/`; query keys only from `lib/query-keys.ts`; no storage of token/text/position outside `lib/assistant/active-store.ts`; no `dangerouslySetInnerHTML`; no `Authorization`/`setAccessToken`/`refreshSession` in W05 files; no index keys in W05 files; `app/chat/page.tsx` is a Server Component with request reads inside `<Suspense>`; no `use cache` in `app/chat/` (AS-67, AS-68, AS-69, gap T8). Expect red for the right reason
- [X] T006 Register `assistant.active` and `assistant.sheetOpen` in `packages/web/lib/browser-storage-keys.ts` (+ its test) and list them on the privacy page (FR-071, R-12)

## Phase 2: Foundational — contracts and backend (B-1…B-6)

- [X] T007 [P] Write failing contract tests `packages/contracts/src/chat/{inbox,receipts,hub-events}.test.ts` for the new schemas (B-5)
- [X] T008 Add `chatInboxItemSchema`, `chatInboxPageSchema` (`{items, nextCursor}`), `chatReceiptsSchema` (`{items:{userId,lastReadSeq}[], suppressed}`) and `chatHubEventSchema` (discriminated union incl. existing `read`/`presence`, plus `message {channelId,messageId,seq}`, `message_deleted {channelId,messageId}`, `channel_archived {channelId}`) in `packages/contracts/src/chat/{inbox,receipts,hub-events}.ts`; export from the chat index (B-5, gaps A6, T9, M8)
- [X] T009 Write failing e2e cases for B-1 `GET /chat/channels/mine` in the chat channel e2e spec in `packages/backend` (find it with `scripts/sdd/test-spec.sh chat`): happy (unread equals `/chat/unread`), archived included and after active, order newest `lastMessageAt` first with nulls last, cursor pagination, `limit` 1–100 default 50 with `400` on bad limit/cursor, `401`, only own memberships (IDOR), body parsed by `chatInboxPageSchema`
- [X] T010 Implement B-1 in `packages/backend/libs/domains/chat/api/chat-channel.controller.ts` + `ChatChannelService` + repository: one query (no N+1), opaque keyset cursor on `(lastMessageAt desc nulls last, channelId)`, items `chatChannel & {unread,lastSeq,lastMessageAt}`, thin controller
- [X] T011 Write failing e2e for B-2 in the chat message/moderation/channel e2e specs: the hub spy receives exactly one `message`/`message_deleted`/`channel_archived` on `chat:<id>` (`replay:false`) per write, none on an idempotent replay (`duplicate:true`), none on a failed write, and a hub failure never fails the write
- [X] T012 Implement B-2: publish the three events after the originating write commits, through the existing `RealtimeHubPort` (`packages/backend/libs/domains/chat/infra/realtime-hub.adapter.ts`, message/moderation/channel services); no new transaction
- [X] T013 Write failing e2e for B-3 `GET /chat/channels/:id/receipts` in the chat read-state e2e: happy (all active members), `suppressed:true` with no items above 50 members, non-member `404/403` per S24 policy, `401`, `400` for a bad id, body parsed by `chatReceiptsSchema`
- [X] T014 Implement B-3 `GET /chat/channels/:id/receipts` → `{items:{userId,lastReadSeq}[], suppressed}` (active members only) in the chat read-state controller and `ChatReadStateService` (new read method)
- [X] T015 Write/extend the assistant e2e (B-4): send a turn, read history, assert history message `id` equals stream `meta.messageId`; fix in `packages/backend/libs/domains/assistant/` only if it fails (gap M5)
- [X] T016 B-6: grep every backend file touched by T010–T015 for `// S54 T037 audit`; migrate any direct `sequelize.transaction` to `TransactionRunner.run`/`@Transactional` and delete the comment; add no new direct site. Then run `scripts/sdd/test-spec.sh chat` and `scripts/sdd/test-spec.sh assistant` and wait for `GET http://localhost:8000/health/ready`
- [X] T017 Update `docs/spec/capabilities/S24-product-chat.md` (and `S46-*.md` if it describes the history id) for mine, receipts and hub events, keeping `[proof:]`/`[code:]` true (`python3 scripts/livespec/check.py`); never touch `*.reviewed.json`; if a human-signed statement changes list it under '## Spec changes' in gaps.md (R-13)

## Phase 3: Foundational — web libraries (pure logic first)

- [X] T018 [P] Write failing UA9 `packages/web/lib/api/chat.test.ts` (rewrite; drop the old `mergeMessages` test): relative URLs, no `Authorization`, contract-schema parsing, lists as `{items,nextCursor}`, send returns `{message, duplicate}`, `markRead` returns the response, moderation `204`, problem extension members (`mutedUntil`, `Retry-After`) parsed from the raw body (gaps A6, C8, M7, T6)
- [X] T019 [P] Write failing UA8 `packages/web/lib/api/assistant.test.ts`: relative URLs, no `Authorization`, `Idempotency-Key` on send, `Last-Event-ID` on resume, schema mismatch → unexpected-error copy, unknown event skipped, non-JSON data skipped, heartbeat comments ignored, non-increasing ids ignored (AS-67, AS-70)
- [X] T020 [P] Write failing UC9 `packages/web/lib/chat/catch-up.test.ts`: pure `mergeMessages` (merge by `id`, order by `seq`), `createCatchUp` single flight with one trailing run, `hasMore` loop, a cursor per loaded chat, cursor-ahead → discard and reload the newest page (AS-25, AS-30)
- [X] T021 [P] Write failing UC6 `packages/web/lib/chat/pending-messages.test.ts`: reducer `{clientMessageId, body, replyToId, state: sending | failed(network|refused)}`; same `clientMessageId` on Retry; `duplicate:true` shown once; Discard; network failures retried once in order on `online`/reopen, `4xx` never; randomised interleavings of lost responses, retries and live deliveries never duplicate (SC-001; AS-14, AS-16, AS-17)
- [X] T022 [P] Write failing table tests `packages/web/lib/chat/{composer-rules,read-position,receipts,links,errors-copy}.test.ts`: Enter/Shift+Enter/IME, trim, whitespace-only disabled, code-point counter, cut at 4,000, mute timer, banned/archived/429 states; read tracker visible+focused+500 ms debounce, never repeat or lower, `429` wait then one call with the highest position; distinct other readers ≥ `seq`, own excluded, large chat none; `chatHref({channel|product})`; every code of AS-05/AS-18/AS-19 has specific copy chosen by `code`, never `detail` (AS-15, AS-18, AS-19, AS-31, AS-33, SC-007)
- [X] T023 [P] Write failing UA4/UA6 and helpers: `packages/web/lib/assistant/{reply-reducer,problem-copy,resume-schedule,tool-labels,active-store}.test.ts` — phases `idle|sending|streaming|reconnecting|stopping|ended(done|refused|error|stopped|lost)`, `text` after `done` ignored, terminal is final, `meta` twice after reload, refusal replaces text; copy table for `input_rejected`, `too_many_active_turns`, `assistant_unavailable`, `idempotency_in_flight`, `quota_exceeded` (`resetsAt`), `invalid_last_event_id`, terminal `error` codes, `refusal {source:"moderation"}`, wait formatter shared with W01; resume schedule 0/1/2/4/8 s then every 10 s up to 2 min; one `assistant.active` pointer cleared at reply end/delete/sign-out (AS-42, AS-49–AS-52, AS-56–AS-59)
- [X] T024 Rewrite `packages/web/lib/query-keys.ts`: add `chat.*` (inbox, unreadTotal, channel, messages, presence, receipts) and `assistant.*` (conversations, history, usage), replacing `chat.channels`/`chat.messages`; set per-query stale times (inbox 15 s, unreadTotal 30 s, channel 60 s, messages 0 s on reconnect, presence 30 s, conversations 60 s, history 0 s while a reply runs else 60 s, usage 0 s on `done`) following the `lib/query-defaults.ts` pattern (FR-073, gaps A8, A9)
- [X] T025 Rewrite `packages/web/lib/api/chat.ts` with `@marketplace-sandbox/contracts` schemas and W01 `csrfHeaders()`: `inbox`, `unread`, `history`, `sync`, `send(clientMessageId, …)` (the caller supplies the id; no UUID inside), `markRead`, `deleteMessage`, `receipts`, `presence`/`heartbeat`, `byProduct`, `join`, `create`; remove hand-written types; zod parser for problem extension members (gaps A6, C1, C8, M7)
- [X] T026 Rewrite `packages/web/lib/api/assistant.ts` and `packages/web/lib/api/sse-reader.ts`: remove the token read, send `Idempotency-Key`, support `Last-Event-ID`; add `resume`, `cancel`, `history`, conversations list/delete, `usage`; skip unknown/non-JSON events and heartbeat comments, ignore non-increasing ids; drop `NEXT_PUBLIC_SSE_URL` (gaps A7, E2, E3)
- [X] T027 Implement `packages/web/lib/chat/{links,catch-up,pending-messages,composer-rules,read-position,receipts,errors-copy}.ts` to pass T020–T022 (gaps A10, C1)
- [X] T028 Implement `packages/web/lib/assistant/{reply-reducer,problem-copy,resume-schedule,tool-labels,active-store}.ts` to pass T023; `active-store.ts` is the only `sessionStorage` user (ids, running `messageId`, pending question, key; no token, no location) (FR-071)

## Phase 4: User Story 1 — Open a product's chat from the product page (P1)

**Goal**: a buyer pressing **Chat with seller** lands in the conversation; shop staff create it explicitly; refusals are explained in place. **Independent test**: UC1 and the first JC steps.

- [X] T029 [US1] Write failing UC1 `packages/web/components/chat/product-chat-resolver.test.tsx`: lookup → join → `router.replace` to `?channel=` and focus on the field; no join request for an existing member; no create button for role `USER`, **Open chat for this product** for `SELLER`/`ADMIN`; table over `400/404/409 channel_archived/403 banned/429/5xx` copy with **Try again**; `?channel=` never joins (AS-01–AS-05)
- [X] T030 [US1] Write failing UC12 guard part in `packages/web/components/chat/chat-page.test.tsx`: signed-out visitors go through `loginHref` with the full `returnTo` including `?product=` (AS-06)
- [X] T031 [US1] Implement `packages/web/components/chat/product-chat-resolver.tsx` (role from `useAuth().user.role`, no catalogue call, visible 'Opening chat…' `role=status`) and `unavailable-chat.tsx` (gaps A4, B1, B2)
- [X] T032 [US1] In `packages/web/app/products/[slug]/page.tsx` change only the **Chat with seller** link to `chatHref({product})`; if more edits would be needed add a bullet for **W02** in gaps.md

## Phase 5: User Story 2 — Inbox, unread and the navbar badge (P1)

**Goal**: all chats with titles, unread, archived tag and Show more, kept current. **Independent test**: UC2, UC3.

- [X] T033 [P] [US2] Write failing UC2 `packages/web/components/chat/inbox.test.tsx`: order, archived tag, `99+`, `aria-current`, accessible names, skeleton/status, empty copy, error + **Try again**, quiet refresh failure keeps rows, **Show more** appends without reorder and disappears at `nextCursor:null`, refetch on focus/visibility/30 s/after send/after hint, no polling when hidden (AS-07–AS-10)
- [X] T034 [P] [US2] Write failing UC3 `packages/web/components/chat/chat-nav-badge.test.tsx`: sum, `99+`, nothing for 0/unknown/anonymous, no request when anonymous (AS-11)
- [X] T035 [US2] Add to `chat-page.test.tsx`: `?channel=` drives the open chat and inbox rows are links (AS-68)
- [X] T036 [US2] Implement `packages/web/components/chat/{inbox,inbox-row,chat-nav-badge}.tsx` on `queryKeys.chat.inbox` and `chatApi.inbox` (one call, no N+1) (gaps B4–B6, B12)
- [X] T037 [US2] Rewrite `packages/web/app/chat/page.tsx` as a Server Component (static shell outside `<Suspense>`; inside it `requireServerSession(returnTo)`, then `searchParams`, prefetch the first inbox page with the session into a `HydrationBoundary`); add `app/chat/loading.tsx` (`role=status`) and `app/chat/not-found.tsx`; no `use cache` (gaps A1–A3, B3, B13; AS-69)
- [X] T038 [US2] Implement `packages/web/components/chat/chat-shell.tsx` (client: two-pane ≥1024 px, single pane otherwise by `?channel=`; drafts `Map` in `useRef`; focus handling)
- [X] T039 [US2] Mount `ChatNavBadge` in the navbar slot W07 left in `packages/web/components/layout/navbar.tsx`; if no slot exists add a bullet for **W07** in gaps.md

## Phase 6: User Story 3 — Read, send, reply and delete (P1)

**Goal**: history pages, optimistic send with one `clientMessageId`, retry/discard, reply, delete. **Independent test**: UC4–UC7 and JC send.

- [X] T040 [P] [US3] Write failing UC4 `packages/web/components/chat/conversation.test.tsx`: 50 newest ascending, unread divider position and scroll, empty copy, load failure + composer disabled, scroll-back keeps the anchor, 'Start of the chat', failed page keeps the list, labels 'You'/'Seller', day separators, plain-text rendering of `<b>`/Markdown, order by `seq`, `id` keys, only loaded pages rendered (AS-12, AS-13, AS-22)
- [X] T041 [P] [US3] Write failing UC5 `packages/web/components/chat/composer.test.tsx`: bubble within one tick, field emptied and focused, confirm replaces bubble, own hint does not duplicate, 'Message sent' announced, Enter/Shift+Enter/IME, counter, drafts per chat, **Send message** name, banned/muted/archived/rate-limit states, mute timer re-enables, wait copy with Retry disabled then enabled (fake timers), reply chip/cancel/quoted preview/unknown/tombstoned original (AS-14, AS-15, AS-18, AS-19, AS-21)
- [X] T042 [P] [US3] Write failing UC7 `packages/web/components/chat/message-actions.test.tsx`: who sees Delete, confirm focus/Esc, tombstone in place, `403` toast, `404` as success (AS-20)
- [X] T043 [US3] Implement `packages/web/components/chat/{conversation,message-list,message-row,day-separator}.tsx` with `react-virtuoso` (`firstItemIndex`, `followOutput` only at bottom, `computeItemKey` by id), unread divider, `queryKeys.chat.messages` (gaps B7–B9)
- [X] T044 [US3] Implement `packages/web/components/chat/{composer,reply-chip,composer-state}.tsx`: multi-line, code-point counter, optimistic pending bubbles in the conversation `useReducer` keyed by `clientMessageId`, Retry/Discard, auto-retry (gaps C1–C4)
- [X] T045 [US3] Implement `packages/web/components/chat/{message-actions,delete-message-dialog}.tsx` (gap C5)
- [X] T046 [US3] Rewrite `packages/web/tests/chat.spec.ts` (JC, `describe('Product chat')`) part 1: buyer joins from the product page, title shown, URL has `channel`, buyer sends, bubble 'You', history shown on reopen; isolated `register` users, two contexts; add `openProductChat` to `packages/web/tests/helpers.ts` and switch its `login` to `returnTo` (gaps T4, T5)

## Phase 7: User Story 4 — Live delivery and self-healing connection (P1)

**Goal**: a hint triggers one sync; banner, polling fallbacks, `resync`/`revoked`/recreate, offline. **Independent test**: UC8, UC9.

- [X] T047 [US4] Write failing UC8 `packages/web/lib/realtime/chat-stream.test.ts` (tests `use-chat-live` and `chat-topics` over a fake `subscribeTopic`): hint → one sync → message once, announcement coalescing, 15 s safety sync without hints, banner after 3 s, 5 s polling while down, banner cleared only after catch-up, `resync` refetches newest page + inbox + catch-up, `revoked` drops the topic then unavailable or one re-subscribe, jittered back-off bounds, `401` once → W01 flow, offline banner, no polling offline/hidden, catch-up on `online`/visible; topic set = open chat + 8 latest, stable sorted (AS-23–AS-29)
- [X] T048 [US4] Implement `packages/web/lib/realtime/chat-topics.ts` (`selectTopics(openId, inboxItems)`) and `packages/web/hooks/use-chat-live.ts` over `subscribeTopic` from `lib/realtime/user-stream.ts` (one `useEffect` diffing the topic list; no second `EventSource`; banner from `getUserStreamSnapshot()` + `useOnline()`); jittered back-off in `hooks/use-jittered-backoff.ts` if needed (gaps D1–D5, R-03)
- [X] T049 [US4] Implement `packages/web/components/chat/connection-banner.tsx` (status region) and wire `createCatchUp` into `chat-shell.tsx` (FR-041)
- [X] T050 [US4] Extend `packages/web/tests/chat.spec.ts`: the seller sees the buyer's message without reload; the buyer's inbox badge appears after the seller's reply (AS-07, AS-23)

## Phase 8: User Story 5 — Read receipts, jump pill, presence (P2)

**Goal**: read only what is seen; 'Seen by'; presence indicator. **Independent test**: UC10, UC11.

- [X] T051 [P] [US5] Write failing UC10 `packages/web/components/chat/read-tracker.test.tsx`: only visible + focused + in view, debounce, no repeat/lower, badge from response, own sends mark nothing, rate-limit wait then one call with the highest position, scrolled-up view does not move, jump pill name/count, press → shows + marks (AS-31, AS-32, AS-36)
- [X] T052 [P] [US5] Write failing UC11 `packages/web/components/chat/receipts-presence.test.tsx`: 'Seen by n' under own last message, none in large chats, heartbeat on open and every 30 s, hidden pause, 'Seller online' for non-sellers only, `503`/`429` → indicator gone and pause by `Retry-After`, no toast (AS-33–AS-35)
- [X] T053 [US5] Implement `packages/web/hooks/{use-read-tracker,use-presence}.ts` and `packages/web/components/chat/{jump-pill,seen-by,presence-badge}.tsx` (IntersectionObserver; receipts from `chatApi.receipts` + `read` events) (gaps C6, C7)
- [X] T054 [US5] Extend `packages/web/tests/chat.spec.ts`: the buyer's badge clears after viewing; the seller sees 'Seen' (AS-31, AS-33)

## Phase 9: User Story 6 — Chat on a phone, keyboard and screen reader (P2)

**Goal**: single-pane mobile, landmarks, focus order, session end. **Independent test**: UC12, VC.

- [X] T055 [US6] Write failing UC12 rest in `packages/web/components/chat/chat-page.test.tsx`: Back link with focus to heading and back to row, landmarks/names/focus order, menus trap/return, announcements only via status regions, `401` → W01 flow once and drafts/bubbles dropped, `403/404` unavailable state (AS-38–AS-40)
- [X] T056 [US6] Implement the mobile layout in `packages/web/components/chat/chat-shell.tsx` and children: `dvh` height, 44×44 px targets, no horizontal scroll, reduced motion, focus handling (gap B10)
- [X] T057 [US6] Write `packages/web/tests/visual/chat.visual.spec.ts` (VC, `describe('Chat layouts')`): no-chat, alert, inbox with badges, skeleton/empty/error, conversation with divider, composer with counter, 'Not sent', archived banner, muted line, reconnecting/offline banner, pill; desktop 1280×800 (two regions) and mobile 390×800; axe serious/critical = 0 per state; commit baselines (AS-03, AS-05, AS-07, AS-08, AS-12, AS-15, AS-16, AS-18, AS-24, AS-29, AS-32, AS-37–AS-39)

## Phase 10: User Story 7 — Ask the assistant and watch the answer arrive (P1)

**Goal**: the launcher opens a modal sheet; the question streams; tool chips, safe Markdown, location opt-in, allowance meter. **Independent test**: UA1–UA3, UA5 happy path, JA.

- [X] T058 [P] [US7] Write failing UA1 `packages/web/components/assistant/assistant-launcher.test.tsx`: dialog role/name/description, focus in/out, Esc, inert page, anonymous prompt with `loginHref`, session unavailable, empty state; closing the sheet or navigating keeps the reply running and reopening shows progress; `BroadcastChannel('auth')` signed-out → sheet closed, storage and cache cleared, read aborted (AS-41, AS-53, AS-55)
- [X] T059 [P] [US7] Write failing UA2 `packages/web/components/assistant/chat-interface.test.tsx`: bubble sequence, 'Thinking…', append order, follow-scroll, Stop↔Send, 'Answer ready' once, no toast, Enter/Shift+Enter/IME, counter, send disabled while running, location off by default and asked once per switch-on, denial copy, `lat`/`lng` only when on, nothing stored, allowance floor %, update from `done.allowance`, 100 % copy, read failure shows nothing (AS-42, AS-45–AS-47, AS-66)
- [X] T060 [P] [US7] Write failing UA3 `packages/web/components/assistant/chat-message.test.tsx`: three chip states with text per tool, unknown tool, chips keyed by `id`; Markdown allow-list, `<script>`/`<img>` not rendered, link rules (`rel`, http/https/relative only); `role="log"` + `aria-busy`, two announcement regions, bubble prefixes (AS-43, AS-44, AS-66)
- [X] T061 [P] [US7] Write failing UA5 happy part in `packages/web/hooks/use-assistant-chat.test.tsx` (MSW + fake chunked stream): one key per action, reused for the same unsent text, new text → new key (AS-42, AS-45)
- [X] T062 [US7] Rewrite `packages/web/hooks/use-assistant-chat.ts` on `useReducer(replyReducer)` + TanStack Query `assistant.*` keys: send with `Idempotency-Key`, stream, stable ids (no `Date.now()`/index keys) (gaps A11, E2, E6, E7)
- [X] T063 [US7] Implement `packages/web/components/assistant/{assistant-launcher,assistant-sheet,sheet-header,transcript,chat-interface,chat-message,tool-chips,markdown,composer,location-switch,usage-meter,reply-notice}.tsx`: `react-markdown` + `remark-gfm` with `skipHtml`, `allowedElements`, `urlTransform`; location via `hooks/use-browser-location.ts`; no unescaped `'` (gaps E1, E6–E8, E10–E13)
- [X] T064 [US7] Rewrite `packages/web/tests/assistant.spec.ts` (JA, `describe('Shopping assistant')`): open via **AI Assistant**, dialog visible, ask, streamed reply non-empty and not the question; add `openAssistant`, `askAssistant` to `tests/helpers.ts` (AS-41, AS-42; gap T5)

## Phase 11: User Story 8 — A dropped connection never loses an answer; stop (P1)

**Goal**: resume with `Last-Event-ID`, reload re-attach, history fallback, stop, idempotent attach. **Independent test**: UA5, UA4.

- [X] T065 [US8] Write failing UA5 rest in `packages/web/hooks/use-assistant-chat.test.tsx`: 'Reconnecting…', `Last-Event-ID` from the last received id, schedule 0/1/2/4/8 s then 10 s, no repeated or lost text (AS-49); reload re-attach without header, bubble rebuilt, pending text cleared at the end, pointer written/cleared, `404` → empty (AS-48, AS-50); resume `404` → history shows the finished answer or an interrupted note + **Try again**, 2-minute failure copy (AS-51); stop: one cancel call, 'Stopping…', terminal `CANCELLED` note, `409` → history, `404` → AS-51 path, 5 s local abort (AS-52); `409 idempotency_in_flight` → attach, `Idempotent-Replay` once, `422` → new key (AS-54); `401` on send/resume/cancel/history/usage → W01 flow once, partial kept (AS-60)
- [X] T066 [US8] Implement resume, reload re-attach (through `lib/assistant/active-store.ts`), stop, idempotent attach and the history fallback in `packages/web/hooks/use-assistant-chat.ts` and `packages/web/lib/api/assistant.ts` (gaps E3, E4, E14)
- [X] T067 [US8] Extend `packages/web/tests/assistant.spec.ts`: ask, reload, reopen → the conversation history is visible (AS-48)

## Phase 12: User Story 9 — Every refusal and error explained in place (P1)

**Goal**: specific inline copy for each code. **Independent test**: UA6 and the notice assertions.

- [X] T068 [US9] Add failing assertions to `packages/web/components/assistant/chat-interface.test.tsx`: inline `role=alert`, text kept, wait timers, partial text kept on terminal error, **Try again** puts the text back with no auto-resend, refusal replaces streamed text with a 'not saved' note and hides the category, used-up allowance disables the composer with the date, timer re-enables and usage is re-read (AS-56–AS-59)
- [X] T069 [US9] Drive `packages/web/components/assistant/reply-notice.tsx` from `lib/assistant/problem-copy.ts`; remove every `toast.error` from the assistant hook (gap E5)
- [X] T070 [US9] Write `packages/web/tests/visual/assistant.visual.spec.ts` (VA, `describe('Assistant sheet layouts')`): signed-out, empty, streaming, chips, meter line, inline alert, error note, list in sheet; 390×800 full-screen and 1280×800 right panel; axe 0 serious/critical per state; commit baselines (AS-41–AS-43, AS-47, AS-56, AS-57, AS-61, AS-65, AS-66)

## Phase 13: User Story 10 — Keep, switch and delete assistant conversations (P2)

**Goal**: list, new chat, delete, full conversation. **Independent test**: UA7.

- [X] T071 [US10] Write failing UA7 `packages/web/components/assistant/conversation-list.test.tsx`: newest first, **Show more**, switch loads history, loading/empty/error, running-reply indicator, **New chat** clears with no request, keeps field text and is disabled when empty, delete confirm focus, `204`, `409` copy, `404` as deleted, a full conversation replaces the composer with **New chat** and history stays readable (AS-61–AS-64)
- [X] T072 [US10] Implement `packages/web/components/assistant/{conversation-list,delete-conversation-dialog}.tsx` and wire them into the sheet header (gap E9)

## Phase 14: User Story 11 — Assistant sheet on a phone and with keyboard (P2)

**Goal**: full-screen on phones, composer never covered, tab order, reduced motion. **Independent test**: UA1/UA3 and VA.

- [X] T073 [US11] Implement the sheet layout in `packages/web/components/assistant/assistant-sheet.tsx`: `dvh` height, 44×44 px targets, `SheetDescription`, Stop button accessible name, labelled textarea, `prefers-reduced-motion` (gaps E12, E15)
- [X] T074 [US11] Make `packages/web/components/chat/assistant-launcher.tsx` re-export the real launcher; confirm navbar icon and mobile-menu variants render it; remove the `toggle-assistant` dispatch in `components/layout/navbar.tsx` and the layout-level `<AssistantSheet />` in `app/layout.tsx` if W07 has not (otherwise add a bullet for **W07** in gaps.md) (gaps E1, T11)

## Phase 15: User Story 12 — Everything rides on the same rules (P3)

**Goal**: session, cookie, storage and rendering rules hold. **Independent test**: AR green, lint clean.

- [X] T075 [US12] Delete replaced code: `packages/web/app/chat/chat-view.tsx` (+ test; clears `react-hooks/set-state-in-effect`), `hooks/use-event-stream.ts` (clears `react-hooks/refs`), `lib/api/sse.ts`, old `chat.channels`/`chat.messages` keys, `components/chat/assistant-launcher.tsx` once nothing imports it, `toggle-assistant` remnants, `NEXT_PUBLIC_SSE_URL`, unused `data-testid`s (keep `chat-title`, `chat-message`, `chat-channel`, `assistant-message`, `user-message` while tests use them) (gaps A5, A7)
- [X] T076 [US12] From `packages/web` run `pnpm exec vitest run lib/architecture.test.ts`, `pnpm exec tsc --noEmit` and `pnpm lint`; fix every violation in W05 files, including the three W01/W07-listed lint errors (`chat-view.tsx:109`, `chat-interface.tsx:60`, `use-event-stream.ts:13`) (AS-67–AS-69)

## Phase 16: Polish & cross-cutting

- [X] T077 Create `docs/spec/capabilities/W05-chat-assistant.md` in the format of the W01–W04/W07 pages (rules and behaviors, `[proof:]` to the UC/UA/JC/JA tests, `[code:]` to the files); run `python3 scripts/livespec/check.py` until true; never create or edit a `*.reviewed.json` (R-13)
- [X] T078 Keep `specs/web/W05-chat-assistant/quickstart.md` 'Ops artifacts' accurate and add one row per unverified criterion (SC-001, SC-002, SC-004, SC-005, SC-006, SC-008, SC-009, SC-010: spec, criterion, how to run, status `not run`) to `specs/UNVERIFIED.md`, skipping rows already there; never describe them as verified
- [X] T079 Add '## Sibling-spec follow-ups' to `specs/web/W05-chat-assistant/gaps.md` with bullets `- **<id>**: <what they must adopt>` for **S24** (new mine/receipts/hub events documented; `authorIsShopStaff` M4 not built, "Seller" stays creator-only), **W04** (may link seller rows through `chatHref({product})`), and **W07** / **S48** only where T004, T039, T074 found a gap
- [X] T080 Run the whole web Vitest suite once (`cd packages/web && pnpm exec vitest run`) and the chat and assistant backend suites once (`scripts/sdd/test-spec.sh chat`, `scripts/sdd/test-spec.sh assistant`); fix failures (after 5 attempts on one test, write the blocker, attempts and hypothesis into `questions.md`)

## Dependencies & execution order

- Phase 1 → Phase 2 (contracts/backend) → Phase 3 (libraries) → stories.
- Chat track US1→US2→US3 (shared `chat-shell.tsx`, `chat.spec.ts`), then US4, US5, US6. Assistant track US7→US8→US9→US10→US11 (shared hook and sheet files). The two tracks are independent after Phase 3 and may run in parallel.
- US12 and Phase 16 last. Within a phase `[P]` tasks touch different files; every code task follows its test task.

## Parallel examples

- Phase 3: T018–T023 together (six test files), then T025/T026 and T027/T028.
- US3: T040, T041, T042 together. US7: T058–T061 together.

## Implementation strategy

- MVP: Phases 1–3, US1–US3 (open, inbox, send) and US7 (ask the assistant); then live delivery (US4) and resume (US8); P2/P3 stories last.
- Run the narrowest test per step, whole suites once at the end; after backend edits wait for `GET http://localhost:8000/health/ready`.

## Coverage

- AS-01…AS-70 are covered by the test tasks per `test-plan.md`; gaps A1–M8 per plan.md 'Gap coverage'. Follow-ups: S24 (T018, T021, T025, T027), S46 (T019, T023, T026, T061–T069), S51 (T047–T048), W01 lint and auth (T030, T037, T075–T076), W02 (T032), W03 (T048), W07 (T039, T074).
