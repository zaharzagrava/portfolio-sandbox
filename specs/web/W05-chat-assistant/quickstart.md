# W05 — Quickstart (validation guide)

## Prerequisites

Dev stack running (API `http://localhost:8000`; after backend edits wait for `GET /health/ready` = 200). `pnpm install` at the repo root. The assistant answers from the backend's scripted provider (no key). Playwright starts the web dev server; run it with `--reporter=line --max-failures=1` and only the file of the page changed.

## Scenarios

| Goal | Command | Expected |
|---|---|---|
| Backend: inbox, hub events, receipts | `scripts/sdd/test-spec.sh chat` (narrow: `chat-channels`, `chat-messages`, `chat-read-state`) | green (B-1, B-2, B-3) |
| Backend: assistant history id | `scripts/sdd/test-spec.sh assistant` | green (B-4) |
| Contracts | `cd packages/contracts && pnpm test` | new schemas parse real responses |
| Architecture rules (red first, green at end of Phase 8) | `cd packages/web && pnpm exec vitest run lib/architecture.test.ts` | green |
| Pure logic | `pnpm exec vitest run lib/chat lib/assistant lib/realtime lib/api/chat.test.ts lib/api/assistant.test.ts` | green |
| Chat components | `pnpm exec vitest run components/chat app/chat` | green |
| Assistant | `pnpm exec vitest run components/assistant hooks/use-assistant-chat.test.tsx` | green |
| Static gates | `pnpm exec tsc --noEmit && pnpm lint && pnpm build` | no errors (incl. the three lint errors listed in the W01/W07 follow-ups) |
| Journeys | `pnpm exec playwright test tests/chat.spec.ts` then `tests/assistant.spec.ts` | green |
| Layout and a11y | `pnpm exec playwright test tests/visual/chat.visual.spec.ts` then `assistant.visual.spec.ts` | baselines match, axe 0 serious/critical at 390 and 1280 px |
| Living spec | `python3 scripts/livespec/check.py` | all `[proof:]`/`[code:]` true |
| Final | whole web suite once, then the chat and assistant backend suites once | green |

If one test still fails after five attempts, the blocker, what was tried and the hypothesis go to `questions.md`.

## Ops artifacts

Criteria no automated test proves (also rows in `specs/UNVERIFIED.md`; never describe them as verified):

- **SC-001 (100 ms real-browser timing)**: the unit tests prove the bubble is rendered in the same tick and the no-duplicate property over randomised interleavings; the 100 ms figure is measured by hand in the Performance panel (20 sends on a mid-range laptop, 95th percentile of press-to-paint).
- **SC-002 (one hour offline, 100 % delivered in 5 s)**: unit tests prove the catch-up loop and merge; run by hand: open a chat, set the browser offline for an hour (or stop the stack for the equivalent), post 120 messages from a second account, restore, time until all appear once in order.
- **SC-004 (2 s live, 20 s without stream)**: unit tests prove the hint → sync path and the 15 s/5 s schedules; measure 50 live deliveries with two accounts and the Network panel; repeat with `/api/streams` blocked.
- **SC-005 (first words immediately, 10 s drop loses no words)**: the reducer and fake-stream tests prove ordering and resume; run by hand: ask a long question, toggle offline for 8 s mid-answer, compare the final text to the history after reload.
- **SC-006 (stop confirmed in 2 s)**: the 2 s figure is a real-stack timing; press Stop 20 times on the scripted provider and time to "Stopped…".
- **SC-008 (keyboard-only completion)**: axe scans and per-component key tests cover structure; walk JC and JA flows with the keyboard only and tick each.
- **SC-009 (on-screen keyboard never covers the composer; 44 × 44 px)**: dynamic viewport height cannot be proven in Chromium desktop; test on a phone (iOS Safari and Android Chrome) with the keyboard open on `/chat?channel=…` and in the sheet; the 44 px size is asserted by the visual suite on the `mobile` project.
- **SC-010 (nothing readable from storage or console)**: the architecture test and storage tests prove the code paths; in DevTools after a full session list `sessionStorage` (only `assistant.active`, `assistant.sheetOpen`) and the console (no text or coordinates).
