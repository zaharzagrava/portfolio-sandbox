# Production build re-check, monkey and API fuzzer

Run 2026-10-25 07:36. Production web server on http://localhost:3100 (build of the current sources, built from a copy without test files because the real build fails on test files, see S-6 in security.md), dev server http://localhost:3000 as the control, API on :8000. 20 seller pages opened at desktop (1366) and phone (390) width by a brand-new seller on both servers.

## Re-check of the findings that were only seen on the dev server

| Bug | What | Dev server | Production | Verdict |
|---|---|---|---|---|
| B-003 | "Applying inline style violates style-src" console errors | 1468 errors on 20 pages | 0 errors on 0 pages | **DEV-ONLY NOISE** |
| B-005 | Hydration mismatch console errors | 0 errors on 0 pages | 0 errors on 0 pages | **NOT SEEN on either server** |
| B-026 | Not-found pages answer HTTP 200 | 3 of 5 probes answer 200 | 3 of 5 probes answer 200 | **REAL ON PRODUCTION** |
| B-031 | 401 from /api/bff/session logged as a console error on first load | 3 console errors | 3 console errors | **REAL ON PRODUCTION** |

### Evidence

- B-003, dev example: /dashboard/seller: Applying inline style violates the following Content Security Policy directive 'style-src 'self' 'nonce-S/OwIxHf14bbAAppMFCMrg==''. Either the 'unsafe
- B-003, production example: none
- B-005, dev example: none
- B-005, production example: none
- Other console errors on production (not one of the four): 0

Not-found probes (status as the browser saw it):

| Probe | Dev status | Production status | Production page says |
|---|---|---|---|
| /dashboard/seller/00000000-0000-4000-8000-000000000000 | 200 | 200 | Skip to main content Marketplace Browse Developers Search Lo |
| /dashboard/seller/not-a-uuid | 200 | 200 | Skip to main content Marketplace Browse Developers Search Lo |
| /dashboard/seller/:shopId/no-such-page | 404 | 404 | Skip to main content Marketplace Browse Developers Search Lo |
| /no-such-page-at-all | 404 | 404 | Skip to main content Marketplace Browse Developers Search Lo |
| /products/00000000-0000-4000-8000-000000000000 | 200 | 200 | Skip to main content Marketplace Browse Developers Search Lo |

Anonymous first loads, 401 answers seen (production): /: /api/bff/session; console errors 1 | /login: /api/bff/session; console errors 1 | /search?q=mug: /api/bff/session; console errors 1

Pages with the status that was not 200 on production: none

## Monkey tester on the production build (10 minutes, seed 125708866)

28 distinct findings. By kind: 16 x request-failed, 10 x accessibility, 1 x raw-value-on-page, 1 x page-error.

### request-failed (16)

- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/developers/api-version (click button "MO"): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard (press Space): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller (fill "Search products" (text) with ""): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/inventory (click button "MO"): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/developers/usage?days=7 (click button "Open menu"): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/knowledge?status=QUEUED (click button "Open menu"): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/integrations (click button "Open menu"): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498 (double-click "Open menu"): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/developers/webhooks (click button "Open menu"): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/campaigns (double-click "MO"): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/developers/logs (click button "MO"): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/developers/api-keys (click button "MO"): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/exports (click button "MO"): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/payouts (go back): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/statements (click button "Open menu"): GET /orders: net::ERR_SSL_PROTOCOL_ERROR
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/integrations/offline-conflicts (click button "Open menu"): GET /orders: net::ERR_SSL_PROTOCOL_ERROR

### accessibility (10)

- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/developers/api-version (fill "Search products" (text) with "undefined"): aria-hidden-focus (serious): ARIA hidden element must not be focusable or contain focusable elements; 11 elements, e.g. .focus\:not-sr-only
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/inventory (submit the first form (Enter in a field, or its submit button)): aria-hidden-focus (serious): ARIA hidden element must not be focusable or contain focusable elements; 11 elements, e.g. .focus\:not-sr-only
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/integrations (click a "API version" -> /dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/developers/api-version): aria-hidden-focus (serious): ARIA hidden element must not be focusable or contain focusable elements; 11 elements, e.g. .focus\:not-sr-only
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498?days=7 (select option 0 in ""): aria-hidden-focus (serious): ARIA hidden element must not be focusable or contain focusable elements; 11 elements, e.g. .focus\:not-sr-only
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/developers/api-keys (open /dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/developers/api-keys): color-contrast (serious): Elements must meet minimum color contrast ratio thresholds; 1 elements, e.g. #radix-_R_2amlb_ > .p-6.text-center
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/integrations (open /dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/integrations): color-contrast (serious): Elements must meet minimum color contrast ratio thresholds; 4 elements, e.g. #radix-_R_2amlbH1_
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/integrations (click button "Close"): color-contrast (serious): Elements must meet minimum color contrast ratio thresholds; 6 elements, e.g. .justify-end.w-full.gap-3:nth-child(1) > .items-end.max-w-\[85\%\].min-w-0 > .py-2\.5.px-4.bg-primary > .whitespace-p
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/exports (double-click "Search"): aria-hidden-focus (serious): ARIA hidden element must not be focusable or contain focusable elements; 11 elements, e.g. .focus\:not-sr-only
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/payouts (click a "Storefront widget" -> /dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/widget): aria-hidden-focus (serious): ARIA hidden element must not be focusable or contain focusable elements; 11 elements, e.g. .focus\:not-sr-only
- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/team (click button "Theme"): aria-hidden-focus (serious): ARIA hidden element must not be focusable or contain focusable elements; 11 elements, e.g. .focus\:not-sr-only

### raw-value-on-page (1)

- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/inventory?q=undefined (click button "Search"): raw "undefined" shown on the page

### page-error (1)

- http://localhost:3100/dashboard/seller/01a17200-330d-7030-8133-9a67ab525498/payouts (click button "Search"): Minified React error #418; visit https://react.dev/errors/418?args[]=HTML&args[]= for the full message or use the non-minified dev environment for full errors and additional helpful warnings.

Full files: specs/.checkpoints/qa-monkey/2026-10-25T07-39-37

## API fuzzer (10 minutes, seed 125708866)

The fuzzer talks to the API on :8000 directly (the web server is not in its path), so it behaves the same as on the dev stack; it was run again with a fresh seed.

21 distinct findings.

- 9 x problem+json without a stable "code": GET /api/shops/:shopId/launch-events/:eventId/bookings [404]; POST /api/shops/:shopId/launch-events/:eventId/close [404]; POST /api/shops/:shopId/launch-events/:eventId/close [404]; POST /api/shops/:shopId/launch-events/:eventId/close [404] ...
- 6 x expected 401 but got 404: GET /api/media/:id [404]; GET /api/media/:id [404]; GET /api/shops/by-slug/:slug/sso [404]; GET /api/shops/by-slug/:slug/sso [404] ...
- 4 x expected 401 but got 400: GET /api/batch/media [400]; GET /api/batch/media [400]; GET /api/batch/shops [400]; GET /api/batch/shops [400]
- 1 x expected 404/405 but got 400: PATCH /api/shops/:shopId/products/search [400]
- 1 x server error (5xx): POST /api/shops/:shopId/invites [500]

Full file: specs/.checkpoints/qa-fuzz/2026-10-25T07-49-39

---

## Verdicts after reading the evidence (by hand)

Verdicts for the four dev-only findings (the table above holds the numbers; "dev" was the control):

- **B-003 (CSP inline-style console errors): dev-only noise.** 1,468 errors on the dev server over 20 pages x 2 sizes, 0 on the production build. The production server sends a strict policy with a per-request nonce and the pages carry it; the dev server injects inline styles of its own. Close as "dev-only noise".
- **B-005 (hydration mismatch): NOT reproduced by plain page loads on either server (0 of 40 loads each), but REAL ON PRODUCTION once under the monkey.** The monkey's production run logged `Minified React error #418` (HTML text differs between server and browser) once, on `/dashboard/seller/:id/payouts`, right after clicking "Search". So the mismatch is rare and needs interaction or timing, and it is not just a dev-server message. Keep B-005 open with this evidence (low-medium: a mismatch makes React redo the page on the client; no data harm seen). To find the cause: replay with `--seed 125708866 --viewport desktop` (the action log is in `specs/.checkpoints/qa-monkey/2026-10-25T07-39-37/actions.jsonl`) and run the payouts page in a development build, where React names the text that differs.
- **B-026 (not-found pages answer HTTP 200): REAL ON PRODUCTION.** On the production build `/dashboard/seller/<unknown shop id>`, `/dashboard/seller/not-a-uuid` and `/products/<unknown id>` all show the not-found page but with status 200 (a "soft 404"); a bad sub-page and a bad top-level path correctly answer 404. Same on dev. Cause is probably that the shop page streams (`cacheComponents`), so the status line is sent before the lookup finishes. Effect: search engines may index not-found pages as real; the sameness rule R-04 (unknown and foreign shop look the same) still holds. Severity low.
- **B-031 (401 from /api/bff/session as a console error): REAL ON PRODUCTION, harmless.** Every first load of a signed-out visitor makes one `GET /api/bff/session` that answers 401, and Chromium prints one red console line per page (1 per load on production; the dev server adds many more lines of other noise). It is the app asking "am I signed in?". Severity very low; the clean fix is to answer 200 with `{ "user": null }` or skip the call when there is no session cookie. It is only noise for people reading the console and for tests that fail on console errors.

New things from the 10-minute monkey run on the production build (1,177 actions, 28 distinct findings):
- **16 x `GET /orders: net::ERR_SSL_PROTOCOL_ERROR`** after opening the account menu ("MO", "Open menu") on many seller pages: the browser tried to load `/orders` over a secure connection that does not exist. NOT explained: it did not happen on the dev server in earlier monkey runs, and I could not repeat it by hand (the page `/orders` answers 200 over http, no redirect to https). Likely cause is the e2e build setup (`SITE_URL=https://localhost`, HSTS header, a prefetch of the menu link), meaning a test-setup artefact rather than a bug that real visitors hit over https. Status: candidate, needs one look with the monkey's seed (`--seed 125708866`).
- **10 x accessibility (serious)**: `aria-hidden-focus` (11 elements with class `focus:not-sr-only`, the skip-links, sit inside an aria-hidden area but can take focus) on 7 pages, and `color-contrast` on dialogs of the API keys and integrations pages. REAL on production (axe runs on the rendered page), severity medium for keyboard and screen-reader users. Track 6 (`a11y`) owns the fix.
- **raw "undefined" on page** (inventory search): FALSE ALARM. The monkey typed the word "undefined" into the search box and the page showed what was typed.

API fuzzer, 10 minutes, fresh seed (21 distinct findings; the same API as the dev stack):
- **REAL, low-medium: `POST /api/shops/:shopId/invites` answers 500 when the e-mail holds a lone surrogate character** (`"x \ud800 y"`; a normal null character gives a clean 400). Confirmed by hand with `curl` as the demo seller: `--data-raw '{"email":"x \ud800 y","role":"staff"}'` gives `500 internal_error`. The invite area (tenancy) must reject invalid text with a 400 before it reaches the database.
- 9 x problem+json without a stable `code` on `launch-events/...` routes, 6 x `expected 401 got 404` (`/api/media/:id`, `/api/shops/by-slug/:slug/sso`), 4 x `expected 401 got 400` (`/api/batch/media`, `/api/batch/shops`), 1 x `PATCH .../products/search` 400 instead of 404: these are the fuzzer's consistency rules, not security holes. The launch-events routes are not one of the four areas. The 404/400-before-401 answers on batch and sso routes are a choice (they hide whether an id exists) and match the earlier dev findings. Not new, low.
