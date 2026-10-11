# W07 — Quickstart (validation guide)

## Prerequisites

Dev stack running (API at `http://localhost:8000`; wait for `GET /health/ready` = 200 after backend edits). `pnpm install` in `packages/web`. For CSP journeys: `pnpm --filter web build` then `next start` (Playwright's `webServer` does it for `security-headers.spec.ts`).

## Scenarios

| Goal | Command | Expected |
|---|---|---|
| Pure logic and components | `cd packages/web && pnpm test` | all Vitest files green (csp, headers, config, page-name, providers, system states, navbar, legal, docs, widget messages) |
| Frame, states, legal | `pnpm exec playwright test tests/app-shell.spec.ts` | green on `mobile` and `desktop` |
| Headers and CSP | `pnpm exec playwright test tests/security-headers.spec.ts` | 100 distinct nonces, static headers, no CSP violations in the journeys |
| Developer docs | `pnpm exec playwright test tests/developer-docs.spec.ts` | list, expand/collapse, one data request, no try-it-out |
| Widget application | `pnpm exec playwright test tests/widget-embed.spec.ts` | bundle headers; identity and close messages |
| Visual | `pnpm exec playwright test tests/app-shell.visual.spec.ts` | screenshots match |
| Backend endpoints | `/opt/sdd/repo/scripts/sdd/test-spec.sh csp-reports` and `... openapi` | green |
| Lint and types | `pnpm lint && pnpm exec tsc --noEmit` | clean |

Contracts: [contracts/](contracts/). Data: [data-model.md](data-model.md).

## Ops artifacts

Criteria no automated test proves (each also a row in `specs/UNVERIFIED.md`, status **not run**):

- **SC-004** (frame CLS ≤ 0.02 on every page while slots load): run Lighthouse or a `PerformanceObserver` layout-shift capture on the production build, signed in and out, at 390 and 1280 px.
- **SC-005** (Log in, Sign up, Cart, Browse, Terms, Privacy within two taps on a phone): manual walk at 390 px from five different pages.
- **SC-006** (message and way forward within 1 s of a failure; the quoted reference finds the request): force each AS-13 failure with a throttled/failing proxy, time to message, then search the backend logs for the shown `requestId`.
