# Implementation Plan: W04 — Seller dashboard (`packages/web` + the backend pieces it needs)

**Branch**: `W04-seller-dashboard` (spec directory only) | **Date**: 2026-10-17 | **Spec**: [spec.md](spec.md)

**Inputs**: `spec.md`, `test-plan.md`, `gaps.md`, `questions.md` (defaults accepted as written, no human edits found), constitution (`.specify/memory/constitution.md`), the follow-ups handed to W04 by S03, S05, S06, S07, S08, S09, S10, S12, S14, S15, S16, S29, S30, S36, S40, S42, S43, S44, S47, S51, J01, W01, W02, W03, W07 (table below). Next.js guides to read before code (`packages/web/AGENTS.md`): *Authentication with Cache Components*, *Rendering philosophy*, `instant`, *Server Functions / forms*, *Redirecting*; re-read at Phase 0 because `packages/web/node_modules/next/dist/docs/` is the authority for Next 16.3.8.

## Summary

Replace the draft seller area (client-only pages, `shops.data?.[0]`, role-claim gate, `window.confirm`, `useState` + `useEffect` data, 4-event webhook list) with the seller dashboard of the spec: shop id in every path, a server guard, a sidebar/drawer shell with switcher and navigation registry, an overview fed by one BFF aggregate plus a live panel on the shared page stream, versioned inventory, API keys / webhooks / deliveries / API version / logs / usage, team + invitations + `/invites/{token}`, a read-only orders page, and the visible form of every problem code.

Order of work (each phase ends green on its own tests; `gaps.md` section G is the same order):

1. **Backend and contracts first** (verified 2026-10-17, `research.md` R-01): the domain routes S03/S05/S10/S32/S40/S42/S43 exist; the only missing server pieces are the overview aggregate (`GET /api/bff/seller/:shopId/overview`, B-1), its contract schema (B-2), `PLATFORM_CURRENCY` / `PUBLIC_API_BASE_URL` configuration (B-3) and two small shape checks (B-4). Built here with e2e specs.
2. **Foundations** (`packages/web/lib`): `queryKeys.seller`, `lib/api/seller*.ts` (parse with contracts), `lib/server/seller.server.ts`, `lib/seller/{permissions,nav,money-input,problem-copy,stock}.ts`, `subscribeTopic` on the shared stream, `useShop`, test helpers.
3. **Shell and routes**: server guard, `[shopId]/layout`, sidebar, drawer, switcher, banners, 404 and forbidden, redirects.
4. **Shop entry → overview + live panel** → **inventory** → **API keys** → **webhooks + deliveries** → **version / logs / usage** → **team + invitation page + orders**.
5. **Follow-up screens** from built specs (S06, S07, S08/S09, S12, S14/S15/S16, S29/S30, S36, S44, S47): one route plus one registry entry each, on the W04 foundations (Phase 9, below).
6. **Delete** what the spec replaces (`app/dashboard/view.tsx` buyer overview, `components/dashboard/orders-table.tsx` if still present, `seller/inventory/*`, `tests/seller.spec.ts`, `instant = false` lines, `pingWebhooks`, `LOW_STOCK` copy), fix the `react-hooks/immutability` lint error and the unused catch bindings (they disappear with the rewrites), and write the living-spec page.

## Technical Context

**Language/Version**: TypeScript 5 strict, Node 20+, React 19.2.8, Next.js 16.3.8 (Cache Components on, per-request root layout because of the CSP nonce), NestJS backend (existing).
**Primary Dependencies**: `@tanstack/react-query` 5, `zod` 4 + `@marketplace-sandbox/contracts`, `sonner`, radix `ui/*`, `lucide-react`, `recharts` 3 (the "charting library already in the app"), `react-hook-form` (present; forms may use it or plain state, decided per form in `research.md` R-09). **Test tooling is already installed** (RTL, user-event, jest-dom, `@vitejs/plugin-react`, `msw`, `@axe-core/playwright`; `vitest.config.ts` includes `components/`, `app/`, `lib/`, `hooks/`), so gaps T1–T3, T4 (axe) are closed; still to add: a `tests/visual` set for W04, `@next/playwright` only if R-12 chooses it.
**Storage**: browser: none for W04 (no `localStorage`, `sessionStorage`, cookie reads); secrets live in the open dialog's state; query cache in memory. Backend: no new tables.
**Testing**: Vitest + RTL + MSW for every unit row of `test-plan.md`; Playwright `desktop`/`mobile` for the five `seller-*.spec.ts` journeys and `tests/visual/seller-*.spec.ts` (axe on each state); backend e2e via `scripts/sdd/test-spec.sh`; static gates `tsc --noEmit`, ESLint (`pnpm lint` must be clean, including the `react-hooks/immutability` error), `next build`, `lib/architecture.test.ts` (AS-92, AS-93).
**Target Platform**: evergreen browsers; Next on Node behind the same-origin rewrites (`/api/bff/:path*` to the BFF, `/api/:path*` through the forwarder).
**Project Type**: web application (`packages/web`) with a backend addition in `composition/bff` and shared schemas in `packages/contracts`.
**Performance Goals**: SC-001, SC-002, SC-003, SC-008, SC-009 are real-browser timings or human tasks → "Ops artifacts" rows in `quickstart.md` and `specs/UNVERIFIED.md`; their structure (throttle ≤ 1 invalidation / 30 s, optimistic-free writes, skeletons shaped like layouts) is unit- or visual-tested.
**Constraints**: relative same-origin URLs only; no `Authorization`, no token in JS; no new Context or global store; no `use cache` around per-user data; no new direct `sequelize.transaction`; sentence-case copy; no `window.confirm`.
**Scale/Scope**: 12 routes + `/invites/[token]`, ~70 components/modules, 6 `lib/api` modules, 1 server data module, 1 BFF aggregate, ~45 unit files, 5 journey files, 5 visual files, plus Phase 9 screens (9 routes).

## Follow-ups from built specs (requirements of this plan)

Each row is a requirement; "Phase" is the plan phase that builds it and the test that proves it.

| Source | Requirement | Phase / test |
|---|---|---|
| S03 | `/invites/<token>`, shop switcher, team and roles screens from `GET /shop-roles` (`{roles: {OWNER:[…],…}, permissions:[…]}`) and `myPermissions`; lists are `{items, nextCursor}` | Phases 3, 8; `shop-switcher.test`, `team-view.test` (AS-79), `accept-invite.test`, journey `seller-team` |
| S05 | web types follow `productPublicSchema` / `productMemberSchema`; routes `/shops/:shopId/products…`; `expectedVersion` on edit/archive/restore | Phase 5; `product-form.test`, `inventory-view.test`; `lib/api/shops.ts` and `catalog.ts` follow-up types are replaced by `lib/api/seller-products.ts` |
| S06 | draft editor page: connect, close codes, reconnect with backoff, `acknowledgeProductVersion` dialog, version list, publish with per-attempt `Idempotency-Key`, brand required (`422 listing_invalid` field `brand`), owns `tests/listing-editor.spec.ts` | Phase 9 (F1) |
| S07 | subscribe `import:<importId>`; `importId`, `parts[].url`, `partSize`, `partCount`; `GET …/upload` resume, `POST …/cancel`, `GET …/error-report`; `Idempotency-Key` 8+ chars per start attempt, reused on retry | Phase 9 (F2) |
| S08 | connect screen `POST …/shopify/install` with `?connected=` / `?error=`; Woo form `POST …/integrations`; status; quarantine list/retry/dismiss (`409 invalid_integration_transition`, `resolution: 'expired'`); reconciliations summaries and detail (`previousRunId`, `outcome`), `sync` `202 {enqueued, reason?}`, `reconcile` `202`, `DELETE` `204`, `400 invalid_uuid` | Phase 9 (F3) |
| S09 | routes/schemas in `packages/contracts/src/catalog-sync/offline-sync.ts` are the contract; conflict event `catalogsync.offline_conflict_opened` is optional for W04 | Phase 9 (F3, conflict list only); event consumption is a non-goal (research R-14) |
| S10 / W07 / S40 | `sellers/me/stats` is unreachable for shop owners: sales cards use `GET /shops/:shopId/stats` through the overview aggregate (already true in the contract; the draft view still shows "—") | Phase 4 (overview), deletes `seller/view.tsx` stats call; `overview-view.test` |
| S12 | subscribe `order-export:<exportId>`; events `progress|done|failed|cancelled`; `POST /shops/:shopId/order-exports` with `Idempotency-Key`; `exportId`; download only via `…/download`; `409 export_already_active {activeExportId}` opens the existing export (L-010) | Phase 9 (F4) |
| S14 / J01 | balance card parses `balanceSchema`; `400` for malformed shop id / unknown query | Phase 9 (F5): the existing `[shopId]/balance-card.tsx` is moved under the shell and checked against the schema |
| S15 / J01 | payouts page: `payoutPageSchema`, statuses `PENDING|IN_TRANSIT|PAID|FAILED|CANCELLED`, keyset; `GET …/payouts/upcoming` | Phase 9 (F5): existing `payouts/view.tsx` is kept if it already parses the schemas, else rewritten |
| S16 / J01 | statements tab, "as known on" picker, CSV download | Phase 9 (F5) |
| S29 | gallery screen: `expectedVersion`, FR-073 `code` values, poll `GET /media/:id` until `READY`, never build URLs, `PUT gallery` `200` with body, `complete` `202`/`200` with `rejectCode`; journey `seller-photos.spec.ts` | Phase 9 (F6) |
| S30 | video problem docs carry `videoStatus`; presigned part URLs used as given; per-part retry, resume `GET …/upload`, poll `GET …/videos/:id`, `202` on complete; journey `seller-video.spec.ts` (AS-61) | Phase 9 (F6) |
| S36 | campaign screens: six routes + statement of `contracts/ads-api.md`, show `statusReason`, mutations only for `OWNER`/`ADMIN` | Phase 9 (F7) |
| S40 | routes `rank`, `stats`, `dashboard/today`; frame `shopId`, `windowSeconds`, `last60s.revenueMinor`; SSE data is the hub's `{topic, data}` envelope with the frame in `data` | Phase 2 (`parseLiveFrame`), Phase 4; `live-panel.test` |
| S42 | keys, pin, logs and usage from `contracts/http.md` B; full key shown once | Phases 6, 7 |
| S43 | paginated list and attempts, `POST enable|disable`, replay `202` with `Idempotency-Key`, per-endpoint ping, `webhooks.manage`, `422 endpoint_url_rejected` reasons | Phase 6 |
| S44 | widget dashboard: `widget.manage`, `PATCH` with `expectedVersion`, `200` kill switch with `version` +1, secret shown once, `422 origin_invalid {details:{origin,reason}}`, `422 featured_product_invalid`, `409 site_version_conflict` | Phase 9 (F8), reuses `<RevealSecretDialog />` |
| S47 | seller document screens (create, presigned upload, `uploaded`, polling, `retry`, delete, ask) from `contracts/knowledge-api.md` | Phase 9 (F9) |
| S51 / W03 | handle `resync` (refetch) and `revoked` (drop topic); recreate stream after a final `401`/`403` | Phase 2 `subscribeTopic` over the existing `addTopic`; Phase 4 live panel; `live-panel.test` AS-21, AS-22 |
| W01 | adopt `returnTo`, `loginHref`, `requireServerSession`, read-only `useAuth()`; no `Authorization`, no `setAccessToken` / `refreshSession`; `useRefreshSession()` after a shop opens | Phases 3, 4; `open-shop-form.test` (AS-04), `dashboard-shell.test` (AS-84); `lib/architecture.test.ts` |
| W01 / W07 | `pnpm lint` error `react-hooks/immutability` at `webhooks/view.tsx:50`; unused catch bindings in `api-keys/view.tsx`, `webhooks/view.tsx` | gone with the rewrites of those views (Phase 6); `pnpm lint` clean is a Phase 10 gate |
| W02 | `formatMoney(minor, currency)`; the seller view passes literal `'USD'`; rename `revenueCents` to minor units with the response currency | Phase 4 (every amount uses the response currency; `overview-view.test` AS-11) |
| W03 | `/dashboard/orders` redirect to `/orders` stays; buyer `OrdersTable` / "Recent orders" gone; shop orders from `GET /shops/:shopId/orders` | Phase 3 (redirects), Phase 8 (orders page) |
| W07 | `Referrer-Policy: no-referrer` and page name `/invites/:token` | Phase 8: `next.config.ts` header for `/invites/:path*` (asserted in W07's header test, extended), `lib/routes/page-name.ts` rule |
| `gaps.md` | every item A–G and T1–T11 | "Gap coverage" below |

## Constitution Check

*GATE: passes before research; re-checked after design (below).*

| Rule | Status | Note |
|---|---|---|
| I/II layering, routing | PASS (planned) | the aggregate is a thin controller in `libs/composition/bff` (same shape as `OrderPageController`); no business rule moves into it |
| III transactions | PASS (planned) | B-1 is a read; no transaction. Touched backend files are grepped for `// S54 T037 audit`; any direct `sequelize.transaction` in a file this plan edits is migrated to `TransactionRunner.run` / `@Transactional` and the comment deleted (task B-5) |
| IV communication | PASS | the aggregate reads tenancy and seller-insights over the BFF upstream clients (`upstream/endpoints/*`), never tables (IX.7 R2) |
| V.1-V.4 contracts, errors | PASS (planned) | `sellerOverviewResponseSchema` added to `packages/contracts/src/bff`; stable problem codes; copy chosen by `code`, never by `detail`, except the documented `endpoint_url_rejected` |
| V.6 idempotency | PASS | UI half: `Idempotency-Key` on webhook replay and the F-phase starts (import, export, publish) |
| VI.1 Server Components first | PASS (planned) | every page and `/invites/[token]` is a Server Component with the guard; client leaves are listed in `data-model.md` |
| VI.2 same origin, no tokens | PASS | no `Authorization`, no storage, secrets only in dialog state; CSRF header on every non-GET through `apiClient` |
| VI.3 network only in `lib/api/*` / server modules | PASS (planned) | `lib/architecture.test.ts` asserts; the stream is created in `lib/realtime`, not in components |
| VI.4 state homes | PASS | server data in TanStack Query seeded from the server render; URL for view state; local state for dialogs; no Context, no store (the page stream stays a module-level ref-counted connection) |
| VI.5 authz not only in proxy | PASS | `requireServerSession` is convenience; the API authorizes again; non-member = `404` |
| VI.6 stable keys | PASS (planned) | ids as keys; architecture test rejects index keys in W04 files |
| VI.7 text only | PASS (planned) | titles, URLs, event bodies as text; `pre` for JSON; no `dangerouslySetInnerHTML` |
| VI.8 minimal props | PASS (planned) | server pages pass display fields only; `myPermissions` as a string array |
| VI.9 no business rules in web | PASS | status, overlap limits, version rules, role rules come from the API; the UI hides controls but handles every refusal (FR-008, FR-043). The "low stock ≤ 5" constant is one shared value with S43 (`research.md` R-08) |
| VII.1 static | gate | `tsc`, ESLint, `next build`, architecture test |
| VII.2/3 backend e2e | PASS (planned) | B-1 e2e: happy, `401`, non-member `404`, malformed id `400`, section timeout → `errors[]`, shop failure → `503`, `days` validation, rate limit |
| VII.7 UI testing | PASS (planned) | five journeys, happy path only; failure forms are MSW unit tests |
| VII.8 traceability | PASS | `test-plan.md` has one row per AS-01..AS-98; Phase 9 screens add rows in their own `test-plan` addendum (`tasks.md`) |
| VII.9 green run | gate | fallbacks forced: partial overview (AS-17), reconnect (AS-21), refused stream (AS-22), clipboard denied (AS-47), catalogue unavailable (AS-58), offline (AS-88) |
| IX isolation | PASS | aggregate calls domains over HTTP |
| X boundaries | PASS | web imports `@marketplace-sandbox/contracts` only |
| PR gate contracts | PASS (planned) | schema ships with the endpoint |
| Cross-spec rule 0 | planned | `docs/spec/capabilities/W04-seller-dashboard.md` is created first (Phase 0), `python3 scripts/livespec/check.py` stays green; no `*.reviewed.json` touched |

**Complexity Tracking (justified deviations)**

| Deviation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Backend work inside a web plan (B-1..B-4) | the overview needs one composed answer (IX.7 R2); four browser calls would be N+1 from the client (VI.9) | waiting for S48 blocks the P1 overview; stubbing the answer is a fake |
| Phase 9 follow-up screens although `questions.md` defers them | the run's input lists each as a requirement left for this capability | omitting them leaves open follow-ups; they are last and independent so the core ships first |
| `subscribeTopic` as a thin wrapper over W03's `addTopic` + `subscribeUserEvents` | the spec names `subscribeTopic(topic, handler)`; W03 already exposes `addTopic` (ref-counted, recreates the connection once) | a second stream breaks S51 A-14 |

**Post-design re-check**: unchanged. Two risks found and recorded (`research.md` R-02, R-10): the forwarder blocks `bff/*` paths (the aggregate is reached through the `/api/bff/:path*` rewrite, like W03's order page, so no change), and `shopSchema` may lack `myPermissions` (checked in B-4).

## Project Structure

### Documentation (this feature)

```text
specs/web/W04-seller-dashboard/
├── spec.md  test-plan.md  gaps.md  questions.md  checklists/
├── plan.md            # this file
├── research.md        # decisions R-01..R-14 and verified facts
├── data-model.md      # entities, state homes, URL state, transitions
├── quickstart.md      # run guide + Ops artifacts
└── contracts/
    ├── backend-endpoints.md   # what W04 calls, B-1..B-4, schemas to add
    └── web-modules.md         # exported names, signatures, routes, events
```

### Source code (repository root)

```text
packages/web/
├── app/
│   ├── dashboard/page.tsx                                  # permanentRedirect → /dashboard/seller
│   ├── dashboard/layout.tsx                                # passes children; no client guard
│   ├── dashboard/settings/page.tsx                         # redirect → /account/security
│   ├── dashboard/seller/page.tsx                           # server: 0 → open-shop form, 1 → redirect, n → picker
│   ├── dashboard/seller/open-shop-form.tsx                 # client
│   ├── dashboard/seller/shop-picker.tsx
│   ├── dashboard/seller/inventory/page.tsx                 # redirect to the shop's inventory
│   ├── dashboard/seller/[shopId]/{layout,loading,not-found,error}.tsx   # guard, shop context, shell
│   ├── dashboard/seller/[shopId]/page.tsx                  # overview
│   ├── dashboard/seller/[shopId]/{inventory,orders,team}/{page,loading}.tsx
│   ├── dashboard/seller/[shopId]/developers/{api-keys,webhooks,webhooks/[endpointId],api-version,logs,usage}/{page,loading}.tsx
│   ├── dashboard/seller/[shopId]/{balance-card.tsx,payouts,statements}  # existing, adopted in Phase 9
│   └── invites/[token]/{page,loading}.tsx  accept-invite.tsx
├── components/
│   ├── dashboard/{dashboard-shell,sidebar,mobile-drawer,shop-switcher,banners}.tsx
│   ├── seller/{shop-status-banner,secret-reveal-dialog,problem-states,confirm-dialog,row-menu,page-skeletons,responsive-table,copy-button,filters-sheet}.tsx
│   ├── seller/overview/{overview-view,live-panel,today-card,tiles,rank-card,daily-chart,top-products}.tsx
│   ├── seller/inventory/{inventory-view,product-form,stock-popover,archive-dialog,inventory-toolbar}.tsx
│   ├── seller/developers/{api-keys-view,create-key-dialog,rotate-key-dialog,webhooks-view,endpoint-form,webhook-detail-view,event-panel,api-version-view,request-logs-view,usage-view}.tsx
│   ├── seller/team/{team-view,members-table,invites-table,roles-matrix}.tsx
│   └── seller/orders/orders-view.tsx
├── lib/
│   ├── api/{seller,seller-products,seller-developers,seller-team,seller-orders}.ts   # client calls, contract-parsed
│   ├── server/seller.server.ts                          # server-only reads (shops, shop, overview, lists)
│   ├── seller/{permissions,nav,money-input,problem-copy,stock,search-params,countdown,format-date}.ts
│   ├── realtime/user-stream.ts                          # + subscribeTopic (wrapper)
│   ├── query-keys.ts                                    # queryKeys.seller.* (replaces dashboard/products)
│   └── architecture.test.ts                             # shared with W01/W03; W04 assertions added
├── tests/{seller-shop,seller-live,seller-inventory,seller-developers,seller-team}.spec.ts  helpers.ts (openShop, seedProduct, shopPath)
└── tests/visual/seller-{shell,overview,inventory,developers,team}.spec.ts

packages/backend/libs/composition/bff/seller/{seller-overview.controller,seller-overview.service}.ts  + e2e spec
packages/backend/libs/composition/bff/upstream/endpoints/seller.ts   # tenancy shop read, stats, today, rank
packages/contracts/src/bff/seller-overview.ts                        # sellerOverviewResponseSchema (+ index export)
docs/spec/capabilities/W04-seller-dashboard.md                       # living spec page (rule 0)
specs/UNVERIFIED.md                                                  # rows for the SC criteria no test proves
```

**Structure Decision**: web application: Next.js App Router pages under the existing `app/dashboard/seller` tree, feature components under `components/seller/<area>`, network only in `lib/api/seller*.ts` and `lib/server/seller.server.ts`, one BFF aggregate in `composition/bff`. The old flat `seller/view.tsx`, `seller/inventory/view.tsx` and the two developer views are deleted when their replacements land (never both at once).

## Phases

**Phase 0 — Spec page, research, tooling**: create `docs/spec/capabilities/W04-seller-dashboard.md` from the spec's rules (every `[proof: …]` / `[code: …]` true; run `python3 scripts/livespec/check.py`); re-read the Next guides; verify R-01..R-14 facts again before code; add `tests/helpers.ts` helpers (`openShop`, `seedProduct`, `shopPath`), an `EventSource` stub and clipboard stub in `lib/test/`, MSW handlers file `lib/test/seller-handlers.ts` with problem+json fixtures parsed by the contracts schemas.

**Phase 1 — Backend and contracts** (B-1..B-5, each with its e2e spec): `sellerOverviewResponseSchema`; `GET /bff/seller/:shopId/overview`; configuration keys; shape checks of `shopSchema.myPermissions`, `shopOrderPageSchema`, key/log page shapes; audit comments.

**Phase 2 — Foundations**: `queryKeys.seller`, parse helpers, `lib/api/seller*.ts`, `seller.server.ts`, `permissions`, `nav`, `money-input`, `problem-copy` (catalogue rows), `countdown`, `subscribeTopic`, `useShop`, `useShopWritable`, `RevealSecretDialog`, `ConfirmDialog`, `ProblemStates`, skeletons. Units: `permissions.test`, `money-input.test`, `problem-copy.test`, `subscribe-topic.test`, `secret-reveal-dialog.test`.

**Phase 3 — Shell and routes**: guard + `[shopId]/layout`, sidebar / drawer / switcher / banners, 404 and forbidden, redirects, `loading.tsx` per route, removal of `instant = false`. Units: `dashboard-shell.test`, `shop-switcher.test`, `problem-states.test`. Visual: `seller-shell`.

**Phase 4 — Shop entry, overview, live panel**: `open-shop-form`, picker, overview view (tiles, today, rank, chart + table toggle, top products), live panel. Units: `open-shop-form.test`, `overview-view.test`, `live-panel.test`. Journeys `seller-shop`, `seller-live`. Visual: `seller-overview`.

**Phase 5 — Inventory**: list, tabs/filters/search in the URL, `ProductForm`, stock popover, archive/restore. Units + journey `seller-inventory` + visual.

**Phase 6 — API keys, webhooks, deliveries**: unit tests per view; journey `seller-developers`.

**Phase 7 — API version, request logs, usage.**

**Phase 8 — Team, invitation page, orders**: journey `seller-team`; header + page-name rule for `/invites/*`.

**Phase 9 — Follow-up screens F1..F9** (each: `lib/api` module with contract parsing, one route, one `sellerNavItems` entry, unit tests with MSW, the journey its source spec names; order: F5 (existing finance pages adopted), F2, F4, F1, F6, F3, F7, F8, F9). `tasks.md` details them; they never block Phases 1–8.

**Phase 10 — Delete and gates**: delete replaced files; `tests/seller.spec.ts` removed; `pnpm lint`, `tsc`, `next build`, `lib/architecture.test.ts`, whole W04 Vitest suite, `livespec check`, `UNVERIFIED.md` rows. (Runtime proofs are the final checkpoint's job, not a task.)

## Gap coverage

| Gaps | Home |
|---|---|
| A1–A13 | Phases 2–6 (query/mutation hooks, server pages, key shapes, reveal dialog, confirm dialog, copy failure path) |
| B1–B15 | Phases 3–8, 10 |
| C1–C9 | Phase 2 (contract-parsed `lib/api/seller*.ts`) |
| D1–D9 | Phases 3–8 (shell, tables with captions, dialogs, group legends, skeletons, copy, chart alternatives, date formatting) |
| E1 | B-1 · E2–E10 exist in the domains (R-01), only forwarding is exercised · E11 | B-3 · E12 | B-2 (contracts already have most schemas, R-01) · E13 | dev-only invitation link helper: `tests/helpers.ts` reads the notification dev outbox (R-13) |
| T1–T3 | already installed (verified) · T4 | Phase 3 visual specs (`mobile` project exists) · T5 | Phase 2 · T6, T7 | Phases 0, 4–8 · T8 | Phase 0 · T9 | closed (contracts have source) · T10 | optional, R-12 · T11 | keep `playwright.config.ts` as is |
