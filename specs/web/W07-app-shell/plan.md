# Implementation Plan: W07 — App shell and cross-cutting UI

**Branch**: `W07-app-shell` (spec directory only) | **Date**: 2026-10-11 | **Spec**: [spec.md](spec.md)

**Inputs**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted as written), constitution v3.1.0.

## Summary

Build the persistent frame (header, mobile menu, footer, skip link, single `<main>`, toaster, offline notice), the system states (not-found, error, global-error, loading, access denied, shared `ErrorState`), legal pages, a read-only developer-docs page, the per-response nonce CSP with the static security headers (one `proxy.ts` plus one header module), `robots.txt`, `/health`, the `page_view` emitter, the query-client defaults, and the widget checkout bundle. Approach: Next.js 16 App Router; `proxy.ts` generates the nonce (every document is rendered per request; data caching stays via `"use cache"`); pure modules for policy, headers, config and page names so they can be table-tested; Server Components for layout, footer, legal and docs pages with small client leaves for stateful controls.

## Technical Context

**Language/Version**: TypeScript 5 strict, Node 20+, React 19.2, Next.js 16.3.8 (Cache Components on)
**Primary Dependencies**: next-themes (nonce prop), sonner, @tanstack/react-query 5, radix/shadcn `ui/*`, lucide-react, react-markdown (no raw HTML). Docs viewer: a small read-only renderer over the OpenAPI JSON instead of `swagger-ui-react` (research R-06). New dev dependencies: `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`, `@vitejs/plugin-react`, `msw`, `@axe-core/playwright`.
**Storage**: none in the shell (theme preference in `localStorage` is the only browser storage). No tables, no migrations.
**Testing**: Vitest (jsdom) + RTL + MSW for units; Playwright (`mobile` 390×844, `desktop` 1280×800; production build for CSP journeys); backend e2e through `scripts/sdd/test-spec.sh` for the two backend endpoints.
**Target Platform**: evergreen browsers; Next on Node; ALB routes `/health`.
**Project Type**: web application: `packages/web` mainly; two small backend endpoints in `packages/backend`; schemas in `packages/contracts`.
**Performance Goals**: frame CLS ≤ 0.02 (not automated, see UNVERIFIED); docs viewer adds 0 bytes to other pages; no placeholder flash under 150 ms.
**Constraints**: no `unsafe-inline` scripts, `connect-src 'self'`, no browser-held tokens, no absolute API origin in shell code, no `dangerouslySetInnerHTML`/`eval`.
**Scale/Scope**: 4 pages, 6 route files, ~25 components, 1 proxy, 5 pure lib modules, 4 e2e files + 1 visual, 2 backend endpoints.

## Constitution Check

| Rule | Status | Note |
|---|---|---|
| VI.1 Server Components first | PASS (planned) | layout, header shell, footer, legal, docs page are RSC; client leaves listed in `data-model.md` and enforced by `app/boundaries.test.ts` |
| VI.2 same origin, no browser tokens | PASS for W07 code | `lib/api/client.ts` in-memory token and absolute `NEXT_PUBLIC_API_URL` conflict with `connect-src 'self'`; W01 owns the replacement; see R-09 |
| VI.3 network calls only in `lib/api/*` | PASS | docs data through `lib/api/developers.ts`; ESLint restriction on `fetch`/`axios` outside `lib/api` added |
| VI.4 single home of state | PASS | TanStack Query for server data; theme via next-themes; offline state local to one leaf; no global store |
| VI.5 authorization not only in proxy | PASS | `proxy.ts` makes no access decision (FR-020) |
| VI.6 stable keys | PASS | ids/hrefs as keys; no index keys |
| VI.7 text only, no eval | PASS | no `dangerouslySetInnerHTML`; link schemes validated to http/https |
| VI.8 minimal props | PASS | slots get no data; error states get `Problem` fields only |
| VII.2/3 backend e2e | PASS (planned) | `POST /api/csp-reports`: happy, malformed body still 204, wrong content type still 204, rate limit; OpenAPI route: happy + contract parse |
| VII.7 Playwright / RTL / MSW | PASS | per `test-plan.md` |
| VII.8 traceability | PASS | one row per AS in `test-plan.md` |
| VII.9 green run | gate | recorded at close-out |
| III / IX transactions, DB isolation | N/A | no DB access added. Rule 4: no new `sequelize.transaction`; if a touched backend file carries a `// S54 T037 audit` site it is migrated to `TransactionRunner.run` and the comment deleted |
| V problem+json | PASS | csp-reports always `204`; OpenAPI route errors via the global filter |
| PR gate 6 contracts | PASS | schemas in `packages/contracts` for the report body (lenient) and OpenAPI document |

**Justified deviations (Complexity Tracking)**

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| `/api/csp-reports` has no 401/IDOR case | anonymous by design, always `204`, stores nothing | browsers send reports without credentials |
| `style-src-attr 'unsafe-inline'` | UI libraries set inline style attributes; styles cannot run code | per-element hashing is unworkable with Radix |
| Documents rendered per request (no prerendered shell) | a nonce needs a fresh document (Q1) | hash/SRI policy is experimental |

Post-design re-check: unchanged; no new violations.

## Project Structure

### Documentation

```text
specs/web/W07-app-shell/
├── plan.md  research.md  data-model.md  quickstart.md
├── contracts/ (security-headers.md, shell-components.md, widget-messages.md, backend-endpoints.md)
└── tasks.md   # /speckit-tasks
```

### Source code

```text
packages/web/
├── proxy.ts                         # nonce + CSP; no authorization
├── next.config.ts                   # headers() from lib/security/headers.ts; images from config; redirects; rewrites (+ /api/developers/openapi.json)
├── app/
│   ├── layout.tsx                   # RSC frame; title template; viewport
│   ├── not-found.tsx  error.tsx  global-error.tsx  loading.tsx  robots.ts
│   ├── health/route.ts
│   ├── widget/v1/app.js/route.ts    # checkout bundle
│   ├── privacy/page.tsx  terms/page.tsx
│   └── developers/docs/page.tsx     # RSC + reference.tsx client leaf (dynamic import)
├── components/
│   ├── layout/ navbar.tsx mobile-menu.tsx theme-control.tsx search-row.tsx offline-notice.tsx
│   │           skip-link.tsx route-focus.tsx footer.tsx system-states.tsx page-skeleton.tsx
│   ├── auth/ account-slot.tsx       # contract stand-in (R-08)
│   ├── legal/ on-this-page.tsx
│   ├── analytics/ page-view.tsx
│   └── widget/ checkout-app.tsx
├── lib/
│   ├── config.ts (server-only) config-parse.ts  browser-storage-keys.ts  providers.tsx  query-keys.ts
│   ├── security/ csp.ts headers.ts
│   ├── routes/page-name.ts
│   ├── widget/messages.ts
│   └── api/developers.ts (+ getOpenApiDocument)
├── tests/ app-shell.spec.ts security-headers.spec.ts developer-docs.spec.ts widget-embed.spec.ts app-shell.visual.spec.ts helpers.ts
└── vitest.config.ts  vitest.setup.ts  playwright.config.ts  eslint.config.mjs
packages/backend/    # POST /api/csp-reports; OpenAPI description route; e2e specs
packages/contracts/  # csp-report and openapi-document schemas
```

**Structure Decision**: web application; frontend in `packages/web`, RSC-first; backend additions placed per constitution X.7 (platform toolkit, public API); schemas in `packages/contracts`.

## Gaps coverage (every gaps.md item has a home)

| gaps.md | Plan home |
|---|---|
| A. frame, navbar, footer, system states, focus, `page_view` | P3, P4, P6 |
| B. headers, proxy, config, robots, health, widget; `client.ts` token | P1, P5; `client.ts` token and absolute origin are W01's (sibling follow-up; R-09) |
| C. legal + docs (incl. `swagger-ui-react` decision) | P6, P7 |
| D. query client and keys | P2 |
| E. backend endpoints; host/payment config values | P9; hosts are configuration only |
| F. test tooling, storage-keys module, boundary scans, ESLint fetch restriction | P0, P2 |
| G. cross-capability follow-ups | `## Sibling-spec follow-ups` in `gaps.md`; no sibling spec edited; pattern-map rows P0502/P0903 set to `planned` in P10 (a docs file, not a spec) |

## Phases (feed `/speckit-tasks`)

- **P0 tooling**: install test deps; widen Vitest include (`components/**`, `app/**`, `lib/**`, `hooks/**`, `.test.ts(x)`; exclude `tests/**`) and add a setup file (jest-dom, cleanup, MSW, `matchMedia`/`BroadcastChannel`/`IntersectionObserver` stubs, React plugin); Playwright `mobile`/`desktop` projects, screenshot defaults, production-build `webServer` for CSP specs; helpers `expectNoCspViolations`, `gotoAtWidth`, `headersOf`; ESLint restriction.
- **P1 security core (test first)**: `config-parse.ts`/`config.ts`, `security/csp.ts`, `security/headers.ts`, `proxy.ts`, `next.config.ts` wiring (headers, images, `poweredByHeader: false`, `ALLOWED_ORIGINS`), nonce prop on the theme provider; fix every runtime-data-outside-Suspense error.
- **P2 data rules**: query client (retry decision, reconnect refetch, per-request on server), `query-keys` domain-first plus test, `browser-storage-keys`.
- **P3 frame**: layout, skip link, route focus, navbar RSC with client leaves, theme control, mobile menu, search row, footer, offline notice, toaster, slot stand-ins.
- **P4 system states**: not-found, error, global-error, loading, `ErrorState`/`AccessDeniedState`/`NotFoundState`/`PageSkeleton`.
- **P5 route handlers**: `robots.ts`, `health`, widget bundle, `lib/widget/messages.ts`, `checkout-app`.
- **P6 legal, metadata, analytics**: legal pages, on-this-page, title template, `page-name`, `page-view`.
- **P7 developer docs**: `getOpenApiDocument`, rewrite, read-only viewer leaf, loading and unavailable states; drop `swagger-ui-react`.
- **P8 e2e**: the four Playwright specs plus the visual spec; axe scans; CSP journeys on the production build.
- **P9 backend**: `POST /api/csp-reports`, OpenAPI description route, contracts schemas, e2e via `test-spec.sh`, wait for `/health/ready`.
- **P10 close-out**: full suites once, quickstart and `specs/UNVERIFIED.md` rows, pattern-map status.

Order: P0 → P1 → P2 → (P3, P4, P5 in parallel) → P6 → P7; P9 can start after P0; P8 last; P10 final.
