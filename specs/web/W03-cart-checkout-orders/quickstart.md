# W03 — Quickstart (validation guide)

## Prerequisites

Dev stack running (API `http://localhost:8000`; after backend edits wait for `GET /health/ready` = 200). `pnpm install` at the repo root. Web env (see `packages/web/.env.example`): `PAYMENT_PROVIDER_HOSTS` (CSP hosts for the pay page), `NEXT_PUBLIC_PAYMENT_PUBLISHABLE_KEY`, `NEXT_PUBLIC_PAYMENTS_SANDBOX=true` (non-production only; journeys use the sandbox card picker). For the pay journey the API must settle a payment: either Stripe test keys or the load-test provider setting (`research.md` R-08; the Phase 0 probe records which). Playwright starts the web dev server.

## Scenarios

| Goal | Command | Expected |
|---|---|---|
| Backend: order read | `scripts/sdd/test-spec.sh order-read` | green (B-1) |
| Backend: payment list | `scripts/sdd/test-spec.sh payment-read` | green (B-2) |
| Backend: BFF aggregates | `scripts/sdd/test-spec.sh bff` | green (B-3, B-4; partial sections degrade) |
| Backend: forwarder after cleanup | `scripts/sdd/test-spec.sh bff-forward` | green (`payment/stream` branch gone) |
| Contracts | `cd packages/contracts && pnpm test` | each new schema parses a real response |
| Architecture rules (first, red then green) | `cd packages/web && pnpm exec vitest run lib/checkout/architecture.test.ts` | green at the end of Phase 8 |
| Pure logic | `pnpm exec vitest run lib/checkout lib/cart lib/realtime lib/safe-link.test.ts` | green |
| Components per phase | `pnpm exec vitest run components/cart` (then `checkout`, `orders`, `notifications`) | green |
| Page access | `pnpm exec vitest run app/checkout app/orders` | green |
| Redirect | `pnpm exec vitest run lib/redirects.test.ts` | `/dashboard/orders` → `/orders` permanent |
| Static gates | `pnpm exec tsc --noEmit && pnpm lint && pnpm build` | no errors, no runtime-data-outside-Suspense error |
| Journeys | `pnpm exec playwright test tests/cart-checkout.spec.ts` (then `orders.spec.ts`, `notifications.spec.ts`) | green on `desktop` and `mobile` |
| Layout and a11y | `pnpm exec playwright test tests/visual/cart.spec.ts` (then `checkout`, `orders`, `notifications`) | baselines match, axe 0 serious/critical at 390 and 1280 px |
| Final | whole web suite once, then the backend specs of the touched domains once | green |

Each command above is run with the narrowest target while a phase is open; the whole suite runs once at the end. If one test still fails after five attempts, the blocker, what was tried and the hypothesis go to `questions.md`.

## Ops artifacts

Criteria no automated test proves (also rows in `specs/UNVERIFIED.md`; never describe them as verified):

- **SC-001** (product page to confirmed order in ≤ 8 actions and < 3 minutes with the sandbox card): hand-run on a clean profile with a stopwatch against the dev stack; count deliberate actions; record times. The journey proves the flow completes, not the time.
- **SC-004** (payment status reaches the open page within 2 s live and 7 s polling, 95 %, ≤ 30 polls/min): script 50 payments with the browser Performance panel and the network log; compute the 95th percentile of event-to-render in each mode. The unit tests prove only the polling schedule and its rate cap.
- **SC-005** (cart change correct within 1 s after the server answer for 95 %): record 100 quantity changes in the Performance panel on broadband; compute the 95th percentile of answer-to-stable. Rollback and optimistic update are unit-tested.
- **SC-007 (keyboard part)** (every journey completable with the keyboard alone): walk the journeys JC-1…JC-4, JO-1, JN-1 with the keyboard only and tick each; axe scans and per-component key tests cover the rest.
- **SC-010 (real provider part)** (no card data reachable by page scripts with the real hosted fields): with Stripe test keys, open the pay page, enter a test card, and check in DevTools that the card number is only inside the provider frames (no field in the page's own DOM, no request to the app carrying card data). The sandbox picker and the DOM assertions in UK5 prove the structure, not the provider's frames.
- **SC-002 (two open tabs part)**: the double-click and reload cases are unit-tested; the two-tabs case is one manual run (open `/checkout` in two tabs, press Place order in both within a second, confirm one order in `/orders`).
- **AS-66 live arrival in a browser (JN-1 live)**: with a stack whose stream delivers (see `gaps.md`, blocked item), un-fixme `JN-1 live` in `tests/notifications.spec.ts` and run it; or open the app in two tabs, pay in one and watch the bell of the other rise without reload. The unit tests prove the client side with a stubbed stream.
