# Research: W05 — Product chat and assistant sheet

Verified against the tree on 2026-10-17. Each entry: Decision / Rationale / Alternatives.

## R-01 Backend gaps are real (verified)

- `packages/backend/libs/domains/chat/api/*` routes: channels (`POST`, `by-product`, `:id`, `join`, `PATCH`), messages (`POST`, `GET` page, `DELETE`), `sync`, `unread`, `read`, `presence`, moderation, `ws-ticket`. **Absent**: `GET channels/mine`, `GET channels/:id/receipts`.
- Hub publishing exists only for `read` (`chat-read-state.service.ts:89`) and `presence` (`chat-presence.service.ts:65`). `message`, `message_deleted`, `channel_archived` appear only in domain constants/errors/tests as names, never published to `chat:<id>`.
- `packages/contracts/src/chat` has channel, message, sync, unread, presence, errors, events, ticket schemas but no inbox, receipts or hub-event schema. `packages/contracts/src/assistant` has `stream-events`, `history`, `usage`, `conversation`, `send-message`.
- **Decision**: build B-1, B-2, B-3 and the schemas (B-5) in this plan; the UI degrades without B-2 (polling) and B-3 (events only) as specified, but shipping the UI against missing routes is a fake. **Alternatives**: client-side N+1 (forbidden VI.9); wait for S24 (blocks P1 stories).

## R-02 `GET /chat/channels/mine` shape and query

- **Decision**: reuse `chatChannelSchema` fields + `unread`, `lastSeq`, `lastMessageAt`; keyset on `(lastMessageAt desc nulls last, channelId)` encoded as an opaque cursor; archived rows sort after active ones **in the response** (AS-07) so the cursor key is `(isArchived asc, lastMessageAt desc nulls last, id)`. `unread` computed with the same expression as `GET /chat/unread` (one SQL join of membership, channel, read state) so SC-003 holds by construction. **Rationale**: one call, same unread source. **Alternatives**: separate unread join in the client (N+1 / two truths).

## R-03 Live connection: reuse W03/W04's `subscribeTopic`, do not build `chat-stream.ts`

- `lib/realtime/user-stream.ts` already exports `addTopic(topic, eventTypes)` and `subscribeTopic(topic, handler, eventTypes)` (shipped by W04) with `resync` / `revoked` handling, back-off, 401/403 recreate, single `EventSource`, and `claimStreamBanner`/`getUserStreamSnapshot` health. FR-045's fallback module is therefore **not built**; AS-26/27/28 are proven through this module by `UC8` using a fake of the connection (the module already has its own tests for reconnect).
- Topic set (FR-040): `lib/realtime/chat-topics.ts` computes `selectTopics(openId, inboxItems)` = open chat + up to 8 latest others, stable sorted; `use-chat-live` diffs the set and calls `subscribeTopic` per topic id so refcounts keep unchanged topics (the module recreates the connection once per set change). The event types asked: `message`, `message_deleted`, `channel_archived`, `read`, `presence`.
- If the module's health values do not map to the spec's banner (3 s "Reconnecting…", offline copy), the banner derives from `getUserStreamSnapshot()` + `useOnline()` (exists: `hooks/use-online.ts`); a W03-owned banner claim (`claimStreamBanner`) is **not** used by chat because the chat banner lives in the conversation/inbox (AS-24); chat reads health only.
- **Alternatives**: own `EventSource` (violates S51 A-14, VI.3).

## R-04 Forwarding and credentials

- `lib/api/rewrites.test.ts` ("every other /api path (REST and streams) goes through the BFF forwarder") shows W01/S48 removed the direct stream rewrites; `next.config.ts:47-48` still carries a stale comment. Phase 0 re-verifies with a request against the dev stack: POST event-stream and resume GET arrive unbuffered with `Idempotent-Replay` and `Last-Event-ID` passed. If buffering is found, the fix is S48's; record a bullet "- **S48**: …" under *Sibling-spec follow-ups* in `gaps.md` and keep the unit tests (fake streams) as the proof.
- `lib/api/sse-reader.ts` still reads a token (`gaps A7`); removing it is part of Phase 2 (AS-67). CSRF header for POST/DELETE comes from W01's `csrfHeaders()` (`lib/api/csrf.ts`), used the same way as `lib/api/cart.ts`.

## R-05 Assistant details to confirm in Phase 0/2

- Stream events and error codes are defined in `contracts/src/assistant/stream-events.ts` (`assistantStreamEventSchema` discriminated on `event`); `assistantLastEventIdSchema` (`^\d+-\d+$`) lets the client assert ids before sending `Last-Event-ID` (no `400 invalid_last_event_id` is ever sent).
- B-4: check `assistantHistoryMessageSchema.id` vs `meta.messageId`; if they differ, fix in the S46 domain (add e2e) since AS-51's history fallback needs equality; otherwise the documented fallback (compare counts) is **not** implemented.
- Problem extension members (`mutedUntil`, `used`, `limit`, `resetsAt`, `messageId`, `category`) are read by a zod schema over the raw problem body in `lib/api/{chat,assistant}.ts` (`packages/contracts/problem.ts` has none). `Retry-After`: read from the response header; if S50 does not expose it to the browser, same-origin requests make it readable anyway (the BFF is same-origin).

## R-06 Reply state machine

- **Decision**: `lib/assistant/reply-reducer.ts` with phases `idle | sending | streaming | reconnecting | stopping | ended(done|refused|error|stopped|lost)` (FR-053), actions `send`, `meta`, `text`, `tool`, `terminal`, `connectionLost`, `resumed`, `stopRequested`, `stopFailed`, `reset`; the first terminal is final; ids not increasing ignored (FR-052). The hook owns IO (fetch via `assistantApi`, timers via the pure `resume-schedule`) and only dispatches. **Alternatives**: boolean flags (impossible states representable, the draft's bug class).

## R-07 Pending message lifecycle

- **Decision**: `lib/chat/pending-messages.ts` reducer: `{clientMessageId, body, replyToId, state: sending | failed(network|refused, reason?) , createdOrder}`. Confirmed messages go to the query cache (`chat.messages`) via `mergeMessages`; pending items live in the conversation's `useReducer` and render after confirmed messages in send order (FR-012). Auto-retry (AS-17) fires once per `online`/stream-reopen for `network` failures only, oldest first. `reply_target_invalid` retry creates a new `clientMessageId` without the reference (AS-18). SC-001 is covered by a fast-check property over randomised interleavings of {response lost, retry, live delivery} asserting each `id` appears once and order equals `seq`.

## R-08 Read tracking and receipts

- **Decision**: IntersectionObserver (stubbed in tests) on message rows reports the highest visible `seq` (bottom edge) to `lib/chat/read-position.ts`, which applies visible+focused+debounce 500 ms, never repeats or lowers, handles `429` with `Retry-After` default 10 s, and sets the inbox badge from the response. "Seen by" counts distinct others with position ≥ the message `seq` from `read` events and the receipts endpoint (B-3); until B-3 data arrives nothing is shown (never a guess).

## R-09 Rendering and headers

- `/chat` is a Server Component: static shell; inside `<Suspense>` `await requireServerSession(returnTo)` (returnTo = path + query from `searchParams`) then `prefetchQuery(inbox)` with the session cookie into `HydrationBoundary` (pattern used by W03's orders page; reuse its server-fetch helper in `lib/server/`). Cache Components rejects request reads outside Suspense at build, which is the gate (`next build`). No-store: dynamic pages are not cached; a headers assertion lives in UC12/page test if the framework exposes it, otherwise the build + the absence of `use cache` is the proof (AR).

## R-10 Message list

- **Decision**: `react-virtuoso` (installed) with `firstItemIndex` for prepending without jump, `followOutput` only when at bottom, `computeItemKey` by message id; the jsdom tests stub it (`Virtuoso` renders all items under test with a test double provided by `vitest.setup.ts` or a local mock) so behavior (anchor via `firstItemIndex`, jump pill state) is asserted at the component boundary, and the real scroll is covered by the visual/journey tests. **Alternative**: plain list + manual `scrollTop` correction (more code, same risk).

## R-11 Markdown safety (AS-44)

- **Decision**: keep `react-markdown` v10 (no raw HTML plugin = HTML not rendered), `allowedElements` for paragraph/emphasis/strong/lists/tables/code/pre/a/br, `skipHtml`, `urlTransform` returning the URL only when `http:`, `https:` or a same-site relative path (via `lib/safe-link.ts`/`lib/safe-url.ts`, exist), `components.a` adds `target="_blank" rel="noopener noreferrer"`, images omitted. Streaming: render the accumulated text each event; unfinished constructs show as plain text because remark leaves them literal until closed; layout stability = `min-height` reservation + `contain` is not required.

## R-12 Storage and keys

- `lib/browser-storage-keys.ts` (+ test, privacy page list) registers `assistant.active` and `assistant.sheetOpen`; `lib/api/` is walked by W01 AS-29 for storage use, so the store lives in `lib/assistant/active-store.ts` (like W03's attempt store). Sign-out clears them via the existing `auth` broadcast listener (W01); the sheet also subscribes to `useAuth().status` to close itself (AS-55).

## R-13 Docs and living spec

- No `docs/spec/capabilities/W05-*.md` page exists (W01–W04, W07 do). Rule 0: create `docs/spec/capabilities/W05-chat-assistant.md` following the sibling pages' format when behavior lands (task in Phase 9), and update `S24-product-chat.md` / `S46-shopping-assistant.md` rules for the new endpoints/events (B-1…B-3) first, keeping `[proof:]`/`[code:]` true; `python3 scripts/livespec/check.py` must pass. No `*.reviewed.json` is touched; if S24's page was signed, record under `## Spec changes` in `gaps.md`.

## R-14 Everything else

- `Retry-After` formatting: reuse W01's wait formatter (`lib/api/problem-copy.ts` or its sibling) — one function for FR-063.
- Location: `hooks/use-browser-location.ts` exists (W02); the switch calls it once per switch-on and keeps the coordinates in component state only.
- Drafts per chat: a `Map` in the chat shell's `useRef` (in-memory only, AS-15).
