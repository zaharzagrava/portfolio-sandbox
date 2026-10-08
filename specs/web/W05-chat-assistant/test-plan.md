# Test Plan: W05 — Product chat and the streamed shopping assistant sheet (`packages/web`)

Constitution VII.8 table: one row per acceptance scenario in [`spec.md`](spec.md) (70 scenarios, AS-01 to AS-70), each proven at the lowest layer that can prove it. A dash means the layer does not test that scenario. Where a row names two layers, each proves a different part (stated in the cell); no part is proven twice. "Proven by backend spec" names the backend scenario that owns the rule; the UI never re-tests it (VII.7).

## Layers and conventions

- **UI journey (Playwright, happy path only)**: `packages/web/tests/*.spec.ts` against the real local dev stack (`moon run :dev-monolith`, web on 3000), an isolated user per test (`register`), web-first assertions, no fixed sleeps. Two users in two browser contexts for chat. The assistant answers from the backend's scripted provider (no key). A journey never forces a failure and never asserts a backend rule; failure forms, reconnects, resumes and stops are unit tests with MSW and fake streams. Each file's top-level `describe` names its feature.
- **UI unit (Vitest + React Testing Library)**: `*.test.tsx` / `*.test.ts` next to the code. Queries by role and label, `@testing-library/user-event`, MSW at the network boundary with problem+json fixtures parsed by the `packages/contracts` schemas, `jsdom`, fake timers for countdowns, back-off, heartbeats and polling, a controllable fake for the live connection and for the response stream (chunk by chunk, with drops). They cover UI-only logic, states, copy, focus and accessibility. No markup snapshots.
- **Visual (Playwright screenshot)**: `packages/web/tests/visual/*.spec.ts`. Layout states at mobile (390 × 800, ≤ 640) and desktop (1280 × 800, ≥ 1024) in the `chromium` project plus a `mobile` project. The backend is stubbed with `page.route` (layout only, no behaviour), animations disabled, an `@axe-core/playwright` scan (serious or critical = 0) on each state, screenshots compared to committed baselines.
- **Static gates** (VII.1): `tsc --noEmit`, ESLint, `next build` (Cache Components validation), and `lib/architecture.test.ts` (shared with W03: reads the source — no `fetch`/`axios`/`EventSource` in components or hooks, query keys only from `lib/query-keys.ts`, no new Context or store, no `use cache` in member pages, no token or text in storage, no `dangerouslySetInnerHTML`).
- Fallback and degradation paths (VII.9) each have a forcing test: stream down → 5 s polling (AS-24), no hint from the hub → 15 s safety sync (AS-23), `resync` (AS-26), `revoked` (AS-27), recreate after final refusal (AS-28), presence unavailable (AS-35), reply resume (AS-49), resume expired → history fallback (AS-51), usage read failure (AS-47).

### Test files

| Key | File | Top-level `describe` |
|---|---|---|
| JC | `packages/web/tests/chat.spec.ts` | `Product chat` (rewritten: buyer joins from the product page, seller opens the chat, exchange with unread badge and "Seen") |
| JA | `packages/web/tests/assistant.spec.ts` | `Shopping assistant` (open, ask, streamed reply; reload shows the conversation) |
| VC | `packages/web/tests/visual/chat.visual.spec.ts` | `Chat layouts` |
| VA | `packages/web/tests/visual/assistant.visual.spec.ts` | `Assistant sheet layouts` |
| UC1 | `packages/web/components/chat/product-chat-resolver.test.tsx` | `Product chat resolver` |
| UC2 | `packages/web/components/chat/inbox.test.tsx` | `Chat inbox` |
| UC3 | `packages/web/components/chat/chat-nav-badge.test.tsx` | `Chat nav badge` |
| UC4 | `packages/web/components/chat/conversation.test.tsx` | `Conversation view` |
| UC5 | `packages/web/components/chat/composer.test.tsx` | `Chat composer` |
| UC6 | `packages/web/lib/chat/pending-messages.test.ts` | `Pending messages (client message id lifecycle)` |
| UC7 | `packages/web/components/chat/message-actions.test.tsx` | `Message actions` |
| UC8 | `packages/web/lib/realtime/chat-stream.test.ts` | `Chat live connection` |
| UC9 | `packages/web/lib/chat/catch-up.test.ts` | `Chat catch-up` |
| UC10 | `packages/web/components/chat/read-tracker.test.tsx` | `Read tracker` |
| UC11 | `packages/web/components/chat/receipts-presence.test.tsx` | `Receipts and presence` |
| UC12 | `packages/web/components/chat/chat-page.test.tsx` | `Chat page (guards, panes, keyboard, session end)` |
| UA1 | `packages/web/components/assistant/assistant-launcher.test.tsx` | `Assistant launcher` |
| UA2 | `packages/web/components/assistant/chat-interface.test.tsx` | `Assistant interface` |
| UA3 | `packages/web/components/assistant/chat-message.test.tsx` | `Assistant message` |
| UA4 | `packages/web/lib/assistant/reply-reducer.test.ts` | `Reply phase reducer` |
| UA5 | `packages/web/hooks/use-assistant-chat.test.tsx` | `Assistant chat hook (stream, resume, stop, retry)` |
| UA6 | `packages/web/lib/assistant/problem-copy.test.ts` | `Assistant problem copy` |
| UA7 | `packages/web/components/assistant/conversation-list.test.tsx` | `Assistant conversations` |
| UA8 | `packages/web/lib/api/assistant.test.ts` | `Assistant API client` |
| UA9 | `packages/web/lib/api/chat.test.ts` | `Chat API client` (rewritten; `mergeMessages` moves to `lib/chat/catch-up.ts`) |
| AR | `packages/web/lib/architecture.test.ts` | `Architecture rules` (shared with W03) |

## Scenario table

| Scenario | UI journey (Playwright, happy path) | UI unit (Vitest + RTL) | Visual (Playwright screenshot) | Proven by backend spec (ID) |
|---|---|---|---|---|
| AS-01 buyer joins from the product page | JC `buyer and seller exchange messages`: product page → **Chat with seller** → title shown, URL has `channel` | UC1: lookup → join → `replace`, focus on field, no join when member (AS-02 part excluded) | — | S24 AS-05, AS-07 |
| AS-02 existing member opens | — | UC1: no join request made | — | S24 AS-05 |
| AS-03 no chat yet (buyer) | — | UC1: copy, link, no create button for role `USER` | VC: pane "no chat" state | S24 AS-07 |
| AS-04 shop staff open the chat | JC (seller opens `/chat?product=` and sees the title; creates when none) | UC1: button visibility by role, `403`/`409`/`404` outcomes | — | S24 AS-01–AS-04 |
| AS-05 refusals while resolving | — | UC1: table-driven over `400/404/409 channel_archived/403 banned/429/5xx` copy and Try again | VC: alert state | S24 AS-06, AS-04 |
| AS-06 signed out redirect | — | UC12: guard redirects with full `returnTo` (server function stubbed) | — | W01 AS-65 |
| AS-07 inbox rows and unread badge | JC (buyer's inbox row shows the badge after the seller's reply; accessible name) | UC2: order, archived tag, `99+`, `aria-current`, names | VC: inbox with badges, desktop and mobile | S24 AS-30, FR-030 |
| AS-08 inbox loading, empty, failed | — | UC2: skeleton/status, empty copy, error + Try again, quiet refresh failure keeps rows | VC: skeleton, empty, error | S24 AS-30 |
| AS-09 show more chats | — | UC2: append, no reorder, button gone at `nextCursor: null` | — | S24 AS-30 |
| AS-10 inbox stays current | — | UC2: refetch on focus, visibility, 30 s, after send, after hint, no poll when hidden (fake timers) | — | S24 AS-30 |
| AS-11 navbar unread total | — | UC3: sum, `99+`, nothing for 0/unknown/anonymous, no request when anonymous | — | S24 AS-30 |
| AS-12 opening a conversation | JC (history shown after open) | UC4: 50 newest ascending, unread divider position and scroll, empty copy, load failure + composer disabled | VC: conversation with divider (desktop/mobile) | S24 AS-27 |
| AS-13 scroll-back | — | UC4: prepend keeps anchor, "Start of the chat", failed page keeps list | — | S24 AS-27, FR-023 |
| AS-14 send | JC (buyer sends; bubble "You"; seller's reply later) | UC5: bubble within one tick, field emptied and focused, confirm replaces bubble, own hint does not duplicate, "Message sent" announced | — | S24 AS-09 |
| AS-15 composer rules | — | UC5: Enter/Shift+Enter/IME, trim, whitespace-only disabled, code-point counter, cut at 4,000, drafts kept per chat, accessible names | VC: composer with counter | S24 AS-16 |
| AS-16 failed send, safe retry | — | UC6: same `clientMessageId` on Retry, `duplicate: true` shown once, Discard (MSW) | VC: "Not sent" bubble | S24 AS-10, AS-11, AS-13 |
| AS-17 automatic retry after reconnect | — | UC6: network failures retried once in order on `online`/reopen; `4xx` never | — | S24 AS-10 |
| AS-18 refusals on send (banned, muted, archived, not found, reply target, validation) | — | UC5: table-driven composer states, mute timer re-enables, draft kept | VC: archived banner, muted line | S24 AS-15, AS-16, AS-17 |
| AS-19 rate limit on send | — | UC5: wait copy, Retry disabled then enabled (fake timers) | — | S24 AS-18 |
| AS-20 delete a message | — | UC7: who sees Delete, confirm focus/Esc, tombstone in place, `403` toast, `404` as success | — | S24 AS-26, FR-040 |
| AS-21 reply | — | UC5: chip, cancel, quoted preview, unknown original, tombstoned original | — | S24 AS-15 |
| AS-22 how a message is shown | JC (author labels "You"/"Seller") | UC4: labels, day separators, plain-text rendering of `<b>` and Markdown, order by `seq`, `id` keys | VC: bubbles alignment | S24 AS-26 (tombstone shape) |
| AS-23 live delivery | JC (seller sees the buyer's message without reload) | UC8: hint → one sync → message once, announcement coalescing, 15 s safety sync without hints | — | S24 AS-21; S51 AS-01 |
| AS-24 stream lost, then restored | — | UC8: banner after 3 s, 5 s polling, banner cleared only after catch-up, no duplicates/gaps | VC: reconnecting banner | S51 AS-08–AS-10, AS-66; S24 AS-21 |
| AS-25 catch-up is complete and ordered | — | UC9: cursors per loaded chat, `hasMore` loop, merge by `id`, single flight + one trailing run | — | S24 AS-21–AS-23 |
| AS-26 `resync` | — | UC8: refetch newest page + inbox + catch-up, replaces held messages, no error | — | S51 AS-16, AS-17 |
| AS-27 `revoked` | — | UC8: topic dropped, re-read, unavailable state or one re-subscribe | — | S51 AS-54–AS-58 |
| AS-28 refused stream is recreated | — | UC8: back-off schedule with jitter bounds, session refresh before recreate, `401` once → W01 flow | — | S51 AS-21, AS-22, AS-47–AS-49 |
| AS-29 offline and background tabs | — | UC8: offline banner, no polling, `online` catch-up, hidden pauses, visible catches up | VC: offline banner | S51 A-13 |
| AS-30 cursor ahead of server | — | UC9: discard, reload newest page | — | S24 Edge Cases (cursor ahead) |
| AS-31 when a message counts as read | JC (buyer's badge clears after viewing) | UC10: only visible + focused + in view, debounce, no repeat/lower, badge from response, own sends mark nothing | — | S24 AS-32–AS-34 |
| AS-32 scrolled up | — | UC10: view does not move, pill name/count, press → shows + marks | VC: pill state | S24 AS-32 |
| AS-33 Seen by | JC (seller sees "Seen" after buyer reads) | UC11: counts distinct other readers ≥ `seq`, own excluded, nothing when no data, large chat shows none | — | S24 AS-35, AS-36 |
| AS-34 presence | — | UC11: heartbeat on open and every 30 s, hidden pause, "Seller online" for non-seller only | — | S24 AS-37, AS-39 |
| AS-35 presence is optional | — | UC11: `503`, `429` → indicator gone, heartbeats pause by `Retry-After`, no toast | — | S24 AS-40, AS-41 |
| AS-36 read marking is rate-limited | — | UC10: wait then one call with the highest position | — | S24 AS-32 (limit policy `chat.read.user`) |
| AS-37 desktop layout | — | — | VC: `/chat` and `/chat?channel` at 1280 × 800 (two regions, own scrollers, empty pane, composer fixed) | — |
| AS-38 mobile layout | — | UC12: Back link, focus to heading and back to row | VC: `/chat` inbox and conversation at 390 × 800 (single pane, composer visible, no horizontal scroll) | — |
| AS-39 keyboard and screen reader | — | UC12: landmarks, names, focus order, menus trap/return, announcements only via status regions | VC: axe scan on each chat state | — |
| AS-40 session ends | — | UC12: `401` → W01 flow once, drafts/bubbles dropped; `403/404` unavailable state | — | W01 AS-26, AS-65 |
| AS-41 launcher and sheet | JA `Shopping assistant` (open via "AI Assistant", dialog visible) | UA1: dialog role/name, focus in/out, Esc, inert page, anonymous prompt, session unavailable, empty state | VA: signed-out and empty sheet | S01 (401 semantics) |
| AS-42 ask and stream | JA (reply streams in, non-empty, not the question) | UA2/UA5: bubble sequence, "Thinking…", append order, follow-scroll, Stop↔Send, "Answer ready" once, no toast | VA: streaming state | S46 AS-01, AS-10 |
| AS-43 tool chips | — | UA3: three states per tool with text, unknown name, keyed by `id` | VA: chips | S46 AS-11–AS-13, FR-016 |
| AS-44 answer is text, safely | — | UA3: Markdown allow-list, `<script>`/`<img>` not rendered, link rules | — | — (client-only; VI.7) |
| AS-45 composer rules and safe retry | — | UA2/UA5: Enter/Shift+Enter/IME, counter, key created once per action and reused for the same unsent text, new text new key, send disabled while running | — | S46 AS-63–AS-67 |
| AS-46 device location, opt-in | — | UA2: off by default, once per switch-on, denial copy, `lat`/`lng` only when on, nothing stored | — | S46 AS-13, AS-14 |
| AS-47 allowance meter | — | UA2: floor percentage, updates from `done.allowance`, 100 % copy, read failure shows nothing | VA: meter line | S46 AS-32, AS-42 |
| AS-48 conversations and what survives a reload | JA (second test: ask, reload, reopen → history visible) | UA5: pointer written/cleared, history load, `404` → empty | — | S46 AS-07, AS-08 |
| AS-49 resume after a drop | — | UA5: "Reconnecting…", `Last-Event-ID` from last received id, schedule 0/1/2/4/8 s then 10 s, no repeated/lost text | — | S46 AS-22, AS-26 |
| AS-50 reload mid-answer | — | UA5: re-attach without header, bubble rebuilt, pending text cleared at end | — | S46 AS-23 |
| AS-51 reply cannot be resumed | — | UA5: `404` → history shows finished answer / interrupted note + Try again; 2-minute failure copy | — | S46 AS-25, AS-30 |
| AS-52 stop | — | UA4/UA5: reducer phases, one cancel call, "Stopping…", terminal `CANCELLED` note, `409` → history, `404` → AS-51, 5 s local abort | — | S46 AS-28, AS-29 |
| AS-53 closing the sheet keeps the reply | — | UA1/UA5: sheet closed/navigation → still reading, reopen shows progress, no second reply | — | S46 AS-26, AS-40 |
| AS-54 retried send attaches | — | UA5: `409 idempotency_in_flight` → attach, `Idempotent-Replay` once, `422` → new key | — | S46 AS-63–AS-65 |
| AS-55 sign-out forgets everything | — | UA1: `BroadcastChannel` signed-out → sheet closed, storage and cache cleared, read aborted | — | W01 AS-26 |
| AS-56 rejections before the stream | — | UA6: table-driven copy for every listed code, text kept, alert role, wait timers | VA: inline alert | S46 AS-03–AS-06, AS-36–AS-41, AS-52, AS-53 |
| AS-57 reply ends in an error | — | UA6: table-driven terminal `error` codes, partial text kept, Try again puts text back, no auto-resend | VA: error note | S46 AS-26, AS-30, AS-44–AS-49, AS-55 |
| AS-58 refusals | — | UA6: streamed text replaced, "not saved" note, category hidden | — | S46 AS-51, AS-54 |
| AS-59 allowance used up | — | UA6: composer disabled with date, timer re-enable, usage re-read | — | S46 AS-32, AS-34 |
| AS-60 session ends mid-use | — | UA5: `401` on send/resume/cancel/history/usage → W01 flow once, partial kept, no retry | — | W01 AS-26; S46 AS-04 |
| AS-61 conversation list | — | UA7: newest first, show more, switch loads history, states, running-reply indicator | VA: list in sheet | S46 AS-07 |
| AS-62 new chat | — | UA7: clears, no request, field text kept, disabled when empty | — | — |
| AS-63 delete a conversation | — | UA7: confirm focus, `204`, `409` copy, `404` as deleted | — | S46 AS-09 |
| AS-64 full conversation | — | UA7: composer replaced, **New chat**, history readable | — | S46 AS-41 |
| AS-65 sheet layout | — | — | VA: 390 × 800 full-screen and 1280 × 800 right panel (header, transcript scroller, allowance, composer; list replaces transcript) | — |
| AS-66 sheet keyboard and screen reader | — | UA1/UA3: dialog name/description, tab order, `role="log"` + `aria-busy`, two announcement regions, bubble prefixes, Stop name, reduced motion | VA: axe scan on each sheet state | — |
| AS-67 calls and secrets | — | AR: no `fetch`/`axios`/`EventSource` outside `lib/api`/`lib/realtime`, no storage of tokens/text/positions, no `dangerouslySetInnerHTML`; UA8/UA9: relative URLs, no `Authorization` header | — | S48 AS-51 |
| AS-68 state has one home | — | AR: query keys only from `lib/query-keys.ts`, no new Context/store, URL holds `channel`; UC12: `?channel=` drives the open chat | — | — |
| AS-69 rendering | — | AR: `/chat` page is a Server Component, request reads inside `<Suspense>`, no `use cache` on member data; `next build` as static gate | — | — |
| AS-70 contract tolerance | — | UA8/UA9: schema mismatch → unexpected-error copy, unknown event skipped, non-JSON data skipped, heartbeat comments ignored, non-increasing ids ignored | — | S46 AS-02 (event set); S51 FR-009 |

## Edge-case index (each at exactly one layer)

| Edge case | Layer and row |
|---|---|
| Own message arrives again via sync/hint | UC5 (AS-14) |
| Two tabs of one member | not tested in the UI (server keeps the larger position, S24) |
| Gateway push without `seq` | UC8 (AS-23): hint carries no render |
| 11 messages in 10 s | UC5 (AS-19) |
| Archived while typing | UC5 (AS-18) |
| `meta` twice after a reload | UA5 (AS-50) |
| `text` after `done` | UA4 (AS-42 reducer: terminal is final) |
| Retry-After extremes | UA6 (AS-56 wait formatter shared with W01) |
| Thousands of messages | UC4 (AS-13: only loaded pages rendered) |

## Gates (VII.9)

A bug fix in this capability adds a failing test first. Merge needs a recorded green run of `pnpm --filter web test`, `pnpm --filter web lint`, `tsc --noEmit`, `next build`, the two journey files, and the visual suite.
