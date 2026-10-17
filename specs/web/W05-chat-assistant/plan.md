# Implementation Plan: W05 — Product chat and the streamed shopping assistant sheet (`packages/web` + the backend pieces it needs)

**Branch**: `W05-chat-assistant` (spec directory only) | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md)

**Inputs**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted as written, no human edits found), constitution (`.specify/memory/constitution.md`), the follow-ups handed to W05 by S24, S46, S51, W01, W02, W03, W07 (table below). Next.js guides to read before code: *Authentication with Cache Components*, *Rendering philosophy*, *Building interactive apps*, *Server Functions / forms*, `instant` (re-read at Phase 0 from `packages/web/node_modules/next/dist/docs/`; `packages/web/AGENTS.md` first).

## Summary

Replace the client-only draft (`app/chat/chat-view.tsx`, `components/assistant/*`, `hooks/use-assistant-chat.ts`, the stand-in `components/chat/assistant-launcher.tsx`) with the two features of the spec:

1. **Product chat** `/chat`: a Server Component page (guard + first inbox page hydrated), URL state (`?channel=`, `?product=` resolver), inbox with unread, conversation (history pages, optimistic send with one `clientMessageId` per action, retry/discard, reply, delete), one catch-up routine (single flight) driven by live hints, reconnects, `online`, visibility, `resync`/`revoked`; read tracker, "Seen by", presence; single-pane/two-pane layout.
2. **Assistant sheet**: `<AssistantLauncher />` owns its sheet; a pure reply reducer (closed phases), `Idempotency-Key` per action, resume with `Last-Event-ID`, reload recovery from a per-tab pointer, stop, the full error/refusal copy catalogue, tool chips, safe Markdown, conversation list/new/delete, usage meter, opt-in location.
3. **Backend first** (verified 2026-10-17, `research.md` R-01): S24 has **no** `GET /chat/channels/mine`, **no** `GET /chat/channels/:id/receipts` and publishes **no** `message`/`message_deleted`/`channel_archived` hub events (only `read`/`presence`). The three asks are built here (B-1…B-3) with e2e specs; B-4 verifies/fixes `history.id == meta.messageId`; B-5 adds the missing contract schemas.
4. **Follow-ups from built specs** are requirements (table below). **Delete** what the spec replaces.

## Technical Context

**Language/Version**: TypeScript 5 strict, Node 20+, React 19.2, Next.js 16.3.8 (Cache Components on, per-request root layout because of the CSP nonce), NestJS backend (existing).
**Primary Dependencies**: `@tanstack/react-query` 5, `zod` 4 + `@marketplace-sandbox/contracts`, `react-markdown` + `remark-gfm` (existing; rehype/URL allow-list added by config, no new package), `react-virtuoso` (installed; implementer's choice for the message list), `@microsoft/fetch-event-source` (existing, used by `sse-reader.ts`), `sonner`, radix `ui/*`, `lucide-react`. Test tooling is **already installed** (RTL, user-event, jest-dom, `msw`, `@axe-core/playwright`, `vitest.config.ts` includes `components/ app/ lib/ hooks/` and has `setupFiles`) so gaps T1–T2 are closed; verified in Phase 0. Remaining tooling: Playwright `mobile` project and `tests/visual/` config (verify in Phase 0; add only what is missing).
**Storage**: browser: tab `sessionStorage` for the single `assistant.active` pointer and the "sheet open" flag only (FR-071), registered in `lib/browser-storage-keys.ts` and the privacy page; no other storage; query cache in memory. Backend: no new tables (receipts read `chat_read_state`; mine reads memberships + read state).
**Testing**: Vitest + RTL + MSW for every `U*` row of `test-plan.md`; Playwright `desktop`/`mobile` for `JC`, `JA`; `tests/visual/{chat,assistant}.visual.spec.ts` with axe; backend e2e through `scripts/sdd/test-spec.sh`; static gates `tsc --noEmit`, ESLint, `next build`, `lib/architecture.test.ts` (AR, shared with W03: extend, do not fork).
**Target Platform**: evergreen browsers; Next on Node behind the same-origin BFF forwarder.
**Project Type**: web application with backend additions (chat domain, assistant verification) and shared schemas.
**Performance Goals**: SC-001/SC-004/SC-005 timings are real-browser measurements → UNVERIFIED rows; structure (100 ms optimistic bubble in one tick, polling schedule, back-off, resume schedule) is unit-tested with fake timers.
**Constraints**: relative same-origin URLs only; no `Authorization`, no token in JS; no new Context or global store; server caches none of W05's data; no `use cache`; no new direct `sequelize.transaction`.
**Scale/Scope**: 1 route (`/chat`), ~35 components/modules, 2 `lib/api` modules rewritten, 1 realtime module (conditional), ~24 unit files, 2 journey files, 2 visual files, 3 backend endpoints/publishers.

## Follow-ups from built specs (requirements of this plan)

| Source | Requirement | Plan home / test |
|---|---|---|
| S24 (both bullets) | list routes are pages `{items,nextCursor}` (`/chat/unread`, `/chat/channels/:id/messages`); one `clientMessageId` per user action reused on retry (replay `200 duplicate:true`, other body `422 idempotency_key_reuse`); sync after every (re)connect with jittered back-off; moderation `204`; chat schemas from `packages/contracts` instead of `lib/api/chat.ts` | Phase 2 (`lib/api/chat.ts` rewrite, `pending-messages.ts`), Phase 4, Phase 5; UA9, UC6, UC8, UC9 |
| S46 | `Idempotency-Key` per message; handle `input_rejected`, `too_many_active_turns`, `assistant_unavailable`, `idempotency_in_flight`, `quota_exceeded` (`resetsAt`), `invalid_last_event_id` (never sent); `refusal {source:"moderation"}` replaces shown text; resume with `Last-Event-ID`; `done` has no cost fields and has `allowance`; `use-assistant-chat.ts` and `lib/api/assistant.ts` rewritten past S46's minimal edits | Phase 6; UA4, UA5, UA6, UA8 |
| S51 | handle `resync` (refetch) and `revoked` (drop topic); recreate the stream after a final `401`/`403` | Phase 5 (`chat-stream`/`subscribeTopic` consumer); UC8 |
| W01 lint | `react-hooks/set-state-in-effect` `app/chat/chat-view.tsx:109`, `react/no-unescaped-entities` `components/assistant/chat-interface.tsx:60`, `react-hooks/refs` `hooks/use-event-stream.ts:13` | Removed with the files they live in (Phase 8: `chat-view.tsx`, `chat-interface.tsx` rewritten, `use-event-stream.ts` deleted); `pnpm lint` green is the proof |
| W01 / W03 | adopt `returnTo`, `loginHref`, `requireServerSession`, read-only `useAuth()`; no `Authorization`, no `setAccessToken`/`refreshSession`; reuse the shared `user:<id>` connection, handle `resync`/`revoked` as W03 does | Phase 3 (guard), Phase 5 (`subscribeTopic` from `lib/realtime/user-stream.ts` — **already shipped by W04** — so FR-045's fallback `chat-stream.ts` is NOT built, see R-03); UC12, UC8 |
| W02 | `/chat?product=<id>` is the target of **Chat with seller** | `chatHref({product})` (Phase 2); `app/products/[slug]/page.tsx` link uses it only if W02's file is untouched otherwise (sibling bullet in `gaps.md` if not); UC1, JC |
| W07 | replace the stand-in `AssistantLauncher` (`components/chat/assistant-launcher.tsx`, icon + menu-item) and optional `ChatNavBadge`; the layout-level `AssistantSheet` mount and `toggle-assistant` are removed by W07 (verified: navbar already imports `AssistantLauncher`; the stand-in still renders `components/assistant/assistant-sheet.tsx`) | Phase 6/7: real launcher at `components/assistant/assistant-launcher.tsx`, the old path re-exports it until deleted in Phase 8; `ChatNavBadge` offered at `components/chat/chat-nav-badge.tsx` and mounted in the navbar where W07 left the slot (if none, sibling bullet to **W07**); UA1, UC3 |
| gaps.md | every item A–H, T1–T11 and M1–M8 | "Gap coverage" below |

## Constitution Check

*GATE: passes before research; re-checked after design (below).*

| Rule | Status | Note |
|---|---|---|
| I/II layering, routing | PASS (planned) | B-1…B-3 are thin controller methods; logic in `ChatChannelService`/`ChatReadStateService` (new read methods), ports for the hub publisher already exist |
| III transactions | PASS (planned) | no new transaction; B-1/B-3 are reads, B-2 publishes after commit through the existing outbox/hub port. Files edited by this plan are grepped for `// S54 T037 audit`; any direct `sequelize.transaction` found is migrated to `TransactionRunner.run`/`@Transactional` and the comment deleted (task B-6). Gate: direct-site count in the chat domain does not rise |
| IV communication | PASS | hub events go through the existing `RealtimeHubPort`; no cross-domain table reads (`mine` joins only chat tables; titles are chat-owned) |
| V.1–V.4 contracts, errors | PASS (planned) | schemas for the new bodies in `packages/contracts` (B-5); stable problem codes; copy chosen by `code`, never `detail` |
| V.6 idempotency | PASS | UI half of P0414: one `clientMessageId` per action, `Idempotency-Key` per assistant action, replays are success |
| VI.1 Server Components first | PASS (planned) | `/chat/page.tsx` Server Component + `<Suspense>`; client leaves listed in `data-model.md` |
| VI.2 same origin, no tokens | PASS with one noted deviation | no token anywhere; the per-tab pointer (ids + pending question) is in `sessionStorage` (Complexity Tracking) |
| VI.3 network only in `lib/api/*` | PASS (planned) | `lib/api/chat.ts`, `lib/api/assistant.ts`, `lib/realtime/*`; AR enforces |
| VI.4 state homes | PASS | server data in TanStack Query under `queryKeys.chat.*`/`assistant.*`; open chat = URL; reply phases `useReducer`; **no** Context, **no** store; the shared stream is the existing module-level connection |
| VI.5 authz again | PASS | `requireServerSession` convenience; every S24/S46 route authorizes again; `403/404` handled by FR-015 |
| VI.6 stable keys | PASS (planned) | message `id`, chip `id`, conversation `id`; pending bubbles keyed by `clientMessageId`; AR rejects index keys in W05 files |
| VI.7 text only | PASS (planned) | message bodies plain text; assistant Markdown with allow-list, no HTML/images, link rule; no `dangerouslySetInnerHTML` |
| VI.8 minimal props | PASS (planned) | server page passes the first inbox page via hydration, rows get display fields only |
| VI.9 no business rules in web | PASS | unread, roles, archived, mute, quota, receipts come from the API; the client never derives them; inbox is one call (no N+1) |
| VII.1 static | gate | `tsc`, ESLint (incl. the three W01-listed errors), `next build`, AR |
| VII.2/3 backend e2e | PASS (planned) | B-1…B-4 each get e2e cases: happy, validation, `401`, non-member `404/403`, pagination, large-chat `suppressed`, concurrency n/a (reads) |
| VII.7 UI testing | PASS (planned) | journeys happy path only; failure forms, reconnect, resume, stop = MSW + fake-stream unit tests |
| VII.8 traceability | PASS | `test-plan.md` has one row per AS-01..AS-70 |
| VII.9 green run | gate | fallbacks forced: stream down → 5 s poll (AS-24), no hints → 15 s sync (AS-23), `resync` (AS-26), `revoked` (AS-27), recreate (AS-28), presence off (AS-35), resume (AS-49), history fallback (AS-51), usage failure (AS-47) |
| X boundaries | PASS | web imports `@marketplace-sandbox/contracts` only |

**Complexity Tracking (justified deviations)**

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| `sessionStorage` pointer `assistant.active` (conversation id, running `messageId`, pending question, idempotency key) although VI.2 lists the API | AS-48/AS-50: a reload mid-answer must re-attach to the same reply and reuse the key or it pays for a second turn | in-memory state is lost on reload (the failure P0414 forbids); `localStorage` would survive tabs and sign-outs. No token, no location, only the user's own pending text, removed at reply end/delete/sign-out; confined to `lib/assistant/active-store.ts`, listed in `lib/browser-storage-keys.ts` + privacy page |
| Backend work inside a web plan (B-1…B-4) | the inbox, receipts and live hints call routes/events that do not exist | shipping UI against `404` is a fake; N+1 from the browser is forbidden (VI.9) |
| Module-level pending-send registry per channel is **not** a store | n/a | pending bubbles live in the conversation component's `useReducer`, dropped with the component (AS-40) |

**Post-design re-check**: unchanged. Risk found and resolved: W03/W04 already shipped the shared connection (`subscribeTopic`), so no second stream is created and FR-045's fallback module is not built (R-03). Remaining risk: `subscribeTopic` is a one-topic-per-call API that recreates the connection once per topic-set change; opening a chat plus 8 others is done by one `useEffect` diffing a stable sorted topic list (R-03).

## Project Structure

### Documentation (this feature)

```text
specs/web/W05-chat-assistant/
├── spec.md  test-plan.md  gaps.md  questions.md  checklists/
├── plan.md            # this file
├── research.md        # decisions R-01..R-12 and verified facts
├── data-model.md      # entities, state homes, reply-phase transitions, storage
├── quickstart.md      # run guide + Ops artifacts
└── contracts/
    ├── backend-endpoints.md   # what W05 calls, B-1..B-5, schemas to add
    └── web-modules.md         # exported names, signatures, routes, events
```

### Source code (repository root)

```text
packages/web/
├── app/chat/{page.tsx,loading.tsx,not-found.tsx}       # Server: guard (requireServerSession), Suspense, first inbox page → HydrationBoundary; chat-view.tsx DELETED
├── components/chat/
│   ├── chat-shell.tsx            # client: two-pane / single-pane by ?channel, banner, focus handling
│   ├── inbox.tsx  inbox-row.tsx  # nav "Your chats", Show more, states
│   ├── product-chat-resolver.tsx # ?product= → lookup → join → replace
│   ├── conversation.tsx  message-list.tsx  message-row.tsx  day-separator.tsx  message-actions.tsx  delete-message-dialog.tsx
│   ├── composer.tsx  reply-chip.tsx  composer-state.tsx (banned/muted/archived/rate-limit lines)
│   ├── connection-banner.tsx  jump-pill.tsx  seen-by.tsx  presence-badge.tsx  unavailable-chat.tsx
│   ├── chat-nav-badge.tsx        # optional navbar badge (AS-11)
│   └── assistant-launcher.tsx    # becomes a re-export of components/assistant/assistant-launcher.tsx, deleted in Phase 8
├── components/assistant/
│   ├── assistant-launcher.tsx  assistant-sheet.tsx  sheet-header.tsx  transcript.tsx
│   ├── chat-interface.tsx  chat-message.tsx  tool-chips.tsx  markdown.tsx
│   ├── composer.tsx  location-switch.tsx  usage-meter.tsx  reply-notice.tsx
│   └── conversation-list.tsx  delete-conversation-dialog.tsx
├── hooks/{use-assistant-chat.ts (rewritten),use-chat-live.ts,use-read-tracker.ts,use-presence.ts,use-jittered-backoff.ts?}   # use-event-stream.ts DELETED (Phase 8)
├── lib/
│   ├── query-keys.ts (chat.*, assistant.* replace chat.channels/messages)  routes.ts? (chatHref lives in lib/chat/links.ts per FR-003)
│   ├── api/{chat.ts,assistant.ts}  sse-reader.ts (token read removed; Last-Event-ID + Idempotency-Key support)  sse.ts DELETED
│   ├── chat/{links.ts,catch-up.ts,pending-messages.ts,composer-rules.ts,read-position.ts,receipts.ts,errors-copy.ts}
│   ├── assistant/{reply-reducer.ts,active-store.ts,problem-copy.ts,resume-schedule.ts,tool-labels.ts}
│   ├── realtime/chat-topics.ts   # topic-set selection (open + 8 latest) over subscribeTopic
│   └── browser-storage-keys.ts (+ assistant.active, assistant.sheetOpen)
└── tests/{chat.spec.ts,assistant.spec.ts (rewritten),helpers.ts (+openAssistant,askAssistant,openProductChat)}
    tests/visual/{chat,assistant}.visual.spec.ts

packages/contracts/src/chat/{inbox.ts,receipts.ts,hub-events.ts}  + index exports; assistant: add nothing unless R-05 finds a gap
packages/backend/libs/domains/chat/{api/chat-channel.controller.ts,api/chat-receipts.controller.ts?,application/*,infra/realtime-hub.adapter.ts}   # B-1..B-3
packages/backend/libs/domains/assistant/                 # B-4 only if history id ≠ meta.messageId
docs/spec/capabilities/ (W05 page if the livespec index lists one; see tasks)
```

**Structure Decision**: keep W07/W01/W03 layout; server-only modules end in `.server.ts` with `import 'server-only'`. Components named by UI role; business-free logic (reducer, catch-up merge, pending lifecycle, composer rules, read position, resume schedule, copy tables) are pure modules with table-driven tests next to them.

## Decision tables

**Rendering and cache** (AS-69): no W05 route uses `use cache`. `/chat`: static shell (frame, skeletons) outside `<Suspense>`; inside it `requireServerSession(returnTo)` then `searchParams`; first inbox page prefetched with the session into a `HydrationBoundary`; response `private, no-store` (already the default for dynamic pages — verified by a headers test, R-09). The sheet is a client island that loads nothing until opened.

**Browser cache lifetimes** (FR-073): `chat.inbox` 15 s; `chat.unreadTotal` 30 s; `chat.channel` 60 s; `chat.messages` 0 s on reconnect (invalidated by catch-up); `chat.presence` 30 s; `assistant.conversations` 60 s; `assistant.history` 0 s while a reply runs else 60 s; `assistant.usage` 0 s on `done`. Set per query (`lib/query-defaults.ts` pattern), not by the global default (A9).

**Client/server split**: all `components/chat/*` and `components/assistant/*` are client leaves except `app/chat/page.tsx`, `loading.tsx`, `not-found.tsx`.

**Catch-up (FR-041)**: one module `lib/chat/catch-up.ts` exports a pure `mergeMessages(held, incoming)` and `createCatchUp({sync, readInbox, ...})` single-flight with trailing run; triggers wired in `hooks/use-chat-live.ts`.

## Phases (dependency order; each ends green on its narrowest test)

| Phase | Content | Proof |
|---|---|---|
| 0 | Re-read AGENTS.md + guides; verify tooling (T1–T2 closed), Playwright `mobile` project + visual dir (T3); extend `lib/architecture.test.ts` with the W05 rules **failing first** (no `fetch`/`axios`/`EventSource` in components/hooks, keys only from `query-keys.ts`, no storage of token/text/position, no `dangerouslySetInnerHTML`, no `Authorization`, no index keys); register the two storage keys | `vitest run lib/architecture.test.ts` red for the right reason |
| 1 | **Contracts + backend**: B-5 schemas; B-1 `GET /chat/channels/mine`; B-2 hub events `message`, `message_deleted`, `channel_archived`; B-3 `GET /chat/channels/:id/receipts`; B-4 verify `history.id == meta.messageId`; B-6 T037 audit | `test-spec.sh` on the chat e2e specs touched + contract spec; `GET /health/ready` after edits |
| 2 | Foundations: `query-keys.ts`; `lib/api/chat.ts` (all `chatApi.*`, schema-parsed, problem extension parsers); `lib/api/assistant.ts`; `sse-reader.ts` token removal + `Last-Event-ID`/`Idempotency-Key`; `lib/chat/{links,catch-up,pending-messages,composer-rules,read-position,receipts,errors-copy}.ts`; `lib/assistant/{reply-reducer,problem-copy,resume-schedule,tool-labels,active-store}.ts` | UA4, UA6, UA8, UA9, UC6, UC9 (+ copy and reducer tables) |
| 3 | Chat shell: `/chat` Server page + guard + hydration, inbox (rows, show more, states, 30 s / focus / visibility refresh), product resolver, `ChatNavBadge` | UC1, UC2, UC3, UC12 (guard, panes, `?channel=`) |
| 4 | Conversation: history pages, scroll-back anchor, unread divider, day separators, message rows, composer (rules, counter, drafts), optimistic send/retry/discard/auto-retry, composer-state (banned/muted/archived/429), reply, delete | UC4, UC5, UC6, UC7 |
| 5 | Realtime: `chat-topics` + `use-chat-live` over `subscribeTopic`, banner, 5 s/15 s polling, offline/visibility, `resync`/`revoked`/recreate, cursor-ahead; read tracker, jump pill, receipts "Seen by", presence | UC8, UC9 (AS-30), UC10, UC11 |
| 6 | Assistant: real launcher + sheet (modal, a11y, layout), reducer-driven `use-assistant-chat` (send, stream, resume, reload re-attach, stop, idempotent attach), notices from copy tables, chips, Markdown, conversation list/new/delete, usage meter, location switch | UA1, UA2, UA3, UA5, UA7 |
| 7 | Layout polish + a11y: mobile single-pane, 44 px targets, focus order, reduced motion; wire `ChatNavBadge`/launcher in navbar slots left by W07 | UC12, UA1; VC/VA baselines |
| 8 | Delete old code: `app/chat/chat-view.tsx(+test)`, `hooks/use-event-stream.ts`, `lib/api/sse.ts`, old `chat.channels`/`chat.messages` keys, `mergeMessages` in the API client, stand-in `components/chat/assistant-launcher.tsx`, `toggle-assistant` remnants, `NEXT_PUBLIC_SSE_URL`, `data-testid`s that tests no longer use; `pnpm lint` clean | `tsc`, ESLint, AR |
| 9 | Journeys (`chat.spec.ts`, `assistant.spec.ts`), visual baselines (`VC`, `VA`), UNVERIFIED rows, sibling bullets, whole web Vitest suite once, chat/assistant backend suites once | `playwright test chat assistant`, `vitest run`, `next build`, `test-spec.sh` |

## Backend and contract tasks

| ID | Task | Owner spec | Where | Test |
|---|---|---|---|---|
| B-1 | `GET /chat/channels/mine?limit&cursor` → `{items:(chatChannel & {unread,lastSeq,lastMessageAt})[], nextCursor}`; member's `ACTIVE` channels incl. archived, newest `lastMessageAt` first (nulls last), keyset cursor, `limit` 1–100 default 50; one query (no N+1) | S24 | `chat-channel.controller.ts`, `ChatChannelService`, repository | new cases in the channel e2e: happy (unread equals `/chat/unread`), archived included/after active, order, pagination, `400` bad limit/cursor, `401`, only own memberships (IDOR), parse with the schema |
| B-2 | Publish `message {channelId,messageId,seq}`, `message_deleted {channelId,messageId}`, `channel_archived {channelId}` on hub topic `chat:<id>` (`replay:false`) after the originating write commits, through the existing hub port | S24 | message/moderation/channel services, `realtime-hub.adapter.ts` | message/moderation/channel e2e: hub spy receives exactly one event per write, none on idempotent replay, none on failed write; hub failure never fails the write |
| B-3 | `GET /chat/channels/:id/receipts` → `{items:{userId,lastReadSeq}[], suppressed}`; active members only; `suppressed:true` with no items above 50 members; non-member `404`/`403` per S24 policy | S24 | read-state controller/service | e2e: happy, own position excluded? (returns all active members; the UI excludes self), >50 suppressed, non-member, `401`, `400` |
| B-4 | Assistant history message `id` equals stream `meta.messageId` (verify; fix and test only if different) | S46 | `assistant-turn.service`/history reader | assistant e2e: send a turn, read history, assert id equality |
| B-5 | Schemas `chatInboxItemSchema`, `chatInboxPageSchema`, `chatReceiptsSchema`, `chatHubEventSchema` (discriminated union incl. existing `read`/`presence`) exported from `packages/contracts` | contracts | `packages/contracts/src/chat/` | contract spec parses real e2e responses |
| B-6 | `// S54 T037 audit` grep over every backend file touched; migrate to `TransactionRunner.run` | S54 | touched files | existing suites of those domains |
| - | **Not built, recorded**: `authorIsShopStaff` on messages (M4, low priority, "Seller" label stays creator-only); BFF changes for forwarding (S48 forwarder already sends `/api/chat/*`, `/api/assistant/*`, `/api/streams` through the BFF per `rewrites.test.ts`; Phase 0 re-verifies and records a sibling bullet to **S48** if streaming is buffered) | S24/S48 | - | R-04 |

## Gap coverage (gaps.md → phase)

| Gaps | Phase | Gaps | Phase |
|---|---|---|---|
| A1–A3, A5, A8–A11 | 2, 3, 5, 8 | C6–C8 | 2, 5 |
| A4 (catalogue call removed; role gating from `useAuth().user.role`) | 3 | D1–D5 | 5 |
| A6, T9, M8 | 1 (B-5), 2 | E1, E13 | 6, 8 |
| A7 | 2 (token removed), 8 (`NEXT_PUBLIC_SSE_URL`) | E2–E5, E14 | 2, 6 |
| B1–B3 | 3 | E6–E8 | 2, 6 |
| B4–B6, M1 | 1, 3 | E9–E12, E15 | 6, 7 |
| B7–B9 | 4 | T1–T3 | 0 (verify) |
| B10, B13 | 7, 3 | T4–T5 | 9 |
| B11, M4 | recorded (creator-only label) | T6–T8 | 2, 8, 0 |
| B12 | 3 | T10–T11 | 6 (unit tests; no journey); T11 closed by W07 launcher slot |
| C1–C5, C8 | 2, 4 | M2, M3, M5 | 1 (B-2, B-3, B-4) |
| M6, M7 | 0 (verify forwarder + `Retry-After` exposure; extension members parsed from the raw body in `lib/api/*`) | | |
