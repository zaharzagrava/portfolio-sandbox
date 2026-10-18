---
id: W05
title: Chat and shopping assistant (product chat inbox and conversation, live delivery, read receipts, presence, assistant sheet and streaming answers)
kind: capability
status: draft
generated_at: a2c8f281
depends_on: [S24, S46, S51, W01, W02, W07]
concepts: [realtime-topic-stream, problem-json-errors, idempotency-key, rate-limit-policy]
models: []
scope:
  - packages/web/app/chat/**
  - packages/web/components/chat/**
  - packages/web/components/assistant/**
  - packages/web/hooks/use-chat-live.ts
  - packages/web/hooks/use-read-tracker.ts
  - packages/web/hooks/use-presence.ts
  - packages/web/hooks/use-assistant-chat.ts
  - packages/web/lib/chat/**
  - packages/web/lib/api/chat.ts
  - packages/web/lib/api/assistant.ts
---
# W05 - Chat and shopping assistant
## Purpose
A member talks to a seller about a product and sees every chat they hold in one place, with what they have not read. A shopper asks the assistant from any page and watches the answer arrive. Both work at phone and desktop width, from the keyboard and in every state a member can reach: loading, empty, error, rate-limited, offline and signed out. The rules of chat and assistant belong to S24 and S46; this capability shows them and handles their refusals.

## Entry points
- `/chat`: the inbox and the open conversation; `?channel=` is the open chat and `?product=` opens or creates the chat with that product's seller.
- The assistant sheet, opened by `AssistantLauncher` (icon and menu-item variants) in the navbar and the mobile menu.
- Live topic `chat:{channelId}` on the page's single stream of {{cap:W03}}.

## Rules
- **W05.R-01** The chat page MUST be a Server Component whose session check redirects a signed-out visitor to the login page with `returnTo` before any content is sent. [proof: W05 AS-69]
- **W05.R-02** The open chat MUST be the `channel` in the address and each inbox row MUST be a link. [proof: W05 AS-68]
- **W05.R-03** One user action MUST use one `clientMessageId` on every retry of that send. [proof: W05 AS-14] [code: packages/web/hooks/use-send-messages.ts#useSendMessages]
- **W05.R-04** A message MUST be at most 4000 code points, the counter MUST show from 3500, and Enter MUST send while Shift+Enter and IME composition MUST NOT. [proof: W05 AS-15] [code: packages/web/lib/chat/composer-rules.ts#shouldSendOnKey]
- **W05.R-05** A push MUST be a hint that triggers one sync; the page MUST sync again after every reconnect, with jittered back-off. [proof: W05 AS-24] [code: packages/web/lib/chat/backoff.ts#backoffDelay]
- **W05.R-06** The topic set MUST be the open chat and the 8 latest others, stable and sorted. [proof: W05 AS-23] [code: packages/web/lib/realtime/chat-topics.ts#selectTopics]
- **W05.R-07** `resync` MUST refetch and `revoked` MUST drop that topic; a final `401` MUST run the session-ended flow of {{cap:W01}} once. [proof: W05 AS-26] [code: packages/web/hooks/use-chat-live.ts#useChatLive]
- **W05.R-08** A message MUST be marked read only when it is visible, the tab is focused and it is in view, and never to a lower position. [proof: W05 AS-31] [code: packages/web/hooks/use-read-tracker.ts#useReadTracker]
- **W05.R-09** "Seller online" MUST show to non-sellers only and MUST disappear on `503` or `429` without a toast. [proof: W05 AS-35] [code: packages/web/hooks/use-presence.ts#usePresence]
- **W05.R-10** Text typed by a member or produced by the assistant MUST be rendered as text or as safe Markdown, never as HTML. [proof: W05 AS-12]
- **W05.R-11** Every assistant send MUST carry an `Idempotency-Key`, and a closed connection MUST resume with `Last-Event-ID`. [proof: W05 AS-48] [code: packages/web/lib/api/assistant.ts#assistantApi]
- **W05.R-12** The assistant answer MUST be read as server events through the shared parser, and a `refusal` with source `moderation` MUST replace the shown text. [proof: W05 AS-50] [code: packages/web/lib/api/sse-reader.ts#SseParser]
- **W05.R-13** The assistant sheet MUST be a modal dialog with focus inside on open and returned on close; closing it MUST keep a running reply. [proof: W05 AS-41] [code: packages/web/components/assistant/assistant-launcher.tsx#AssistantLauncher]
- **W05.R-14** Location MUST be off by default, asked once per switch-on, sent as `lat` and `lng` only while on, and never stored. [proof: W05 AS-46]
- **W05.R-15** Network calls MUST use relative same-origin paths without an `Authorization` header, and a sign-out in another tab MUST close the sheet and clear its storage and cache. [proof: W05 AS-67] [code: packages/web/lib/api/chat.ts#chatApi]

## Behaviors
- **W05.B-01** Given a member opens the chat page, then the inbox loads in one call with the unread count per chat and the navbar badge shows the sum, `99+` above 99. [proof: W05 AS-11]
- **W05.B-02** Given a member sends, then a bubble shows within one tick, the field empties and keeps focus, and the server answer replaces the bubble. [proof: W05 AS-14]
- **W05.B-03** Given a send fails, then the bubble reads "Not sent" with Retry and Discard. [proof: W05 AS-16]
- **W05.B-04** Given a member is muted, banned or rate-limited, or the chat is archived, then the composer shows the state and re-enables itself when it ends. [proof: W05 AS-18]
- **W05.B-05** Given the connection is lost, then a banner shows after 3 s, polling runs every 5 s, and the banner clears only after the catch-up. [proof: W05 AS-24]
- **W05.B-06** Given a member has read up to a message, then the sender sees "Seen" under it, and not in large chats. [proof: W05 AS-33]
- **W05.B-07** Given a chat answers `403` or `404`, then the page shows "This chat isn't available." and nothing from the cache for it. [proof: W05 AS-40]
- **W05.B-08** Given a member opens a chat on a phone, then focus moves to its heading, and "Back to all chats" returns focus to its row. [proof: W05 AS-38]
- **W05.B-09** Given a shopper sends a question, then the answer streams in order with tool chips, and "Answer ready" is announced once. [proof: W05 AS-42]
- **W05.B-10** Given a shopper presses Stop, then the read ends and the partial answer stays. [proof: W05 AS-52]
- **W05.B-11** Given the allowance is used up, then the sheet shows the reset time from `resetsAt` and disables sending. [proof: W05 AS-56]
- **W05.B-12** Given a shopper opens conversations in the sheet, then they can switch, and delete one after a confirmation. [proof: W05 AS-58]

## Lifecycles
No model is listed. Channel and message states are S24's; assistant conversations and turns are S46's.

## Owns
- Query keys `chat` and `assistant` in `lib/query-keys.ts`; the modules listed in `scope`.
- Reads the live topic `chat:{channelId}` ({{concept:realtime-topic-stream}}).
- Owns no database table, queue or topic.

## Decisions
- Server data lives in TanStack Query, the open chat in the address, drafts in a ref; no new Context or store.
- Pushes are hints; the source of truth is the sync of the page.
- Failure forms are chosen by problem `code` ({{concept:problem-json-errors}}).

## Known gaps
- Browser and visual proofs (`tests/chat.spec.ts`, `tests/assistant.spec.ts`, `tests/visual/chat.visual.spec.ts`, `tests/visual/assistant.visual.spec.ts`) are not run on this machine; see `specs/UNVERIFIED.md`.
