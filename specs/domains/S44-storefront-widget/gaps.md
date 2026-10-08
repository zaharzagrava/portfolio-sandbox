# Gaps: S44 — Embeddable storefront widget (domain `developer-platform`)

What the current code gets wrong or lacks versus [`spec.md`](spec.md), the open debt-register rows that touch this capability, and this domain's cross-domain access lines. This is the implementation agent's to-do list. Paths are under `packages/backend/libs/domains/developer-platform/` unless stated; `service:` is `application/widget.service.ts`, `controller:` is `api/widget.controller.ts`.

Existing tests: `widget.e2e-spec.ts` (3 tests: config origin rules and CORS, identity hand-off with forgeries and replay, embed CSP and kill switch). It injects the tenancy `Shop` model (`:11`, `:15`, `:45`), creates sites and flips the kill switch by calling `WidgetService` directly instead of over HTTP (`:47`, `:87`, violates VII.2), never exercises the dashboard routes (no RBAC, IDOR or 401 case), tests no concurrency, no `frame-ancestors 'none'` elsewhere, no preflight, no fail-closed path, no consumers. Its three ideas move to AS-14/AS-16, AS-23/AS-25/AS-26 and AS-35/AS-39 and are rewritten; the file is split into the files of `test-plan.md` and deleted.

`pnpm --dir packages/backend check:table-ownership` could not be run while writing this file (running it needs an approval that was not available in this unattended session; the sibling specs S42 and S43 recorded the same). Section 3 is built from reading the code. **The implementation agent must run the command first, reconcile its `developer-platform` lines with section 3, and finish with `--strict` clean for this capability's files (AS-54).**

## 1. Gaps in the code (spec reference → what is wrong or missing → fix)

### Dashboard API (`api/widget.controller.ts`, `application/widget.service.ts`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-01 | FR-001, AS-09 | `create` and `kill` use `ShopScoped('shop.manage')` (`controller:29`, `:35`); no other management route exists. | `ShopScoped('widget.manage')` on every route (S03 adds the permission); table test over all routes for OWNER / ADMIN / STAFF / VIEWER / other shop / anonymous. |
| G-02 | FR-001, AS-09 | `setKillSwitch` filters by `(id, shopId)` (good, `service:63`) but throws a bare `NotFoundException` (`:67`); no list, read, update, delete, rotate, history routes. | Add the routes of the Provides list; every lookup `WHERE id = :id AND "shopId" = :shopId`; `404 widget_site_not_found` identical for unknown and cross-shop. |
| G-03 | FR-003, AS-02 | `ORIGIN` regex (`service:23`) lets IP literals, `localhost`, single-label hosts and bare TLDs through; `normalizeOrigin` (`:28-36`) silently strips path, query and fragment; invalid origins throw `ForbiddenException` (`:50`); no 253-char or port-range rule; IDN accepted only by accident of `URL`. | One pure rule in `domain/origin.ts` with the closed reason list; `422 origin_invalid {origin, reason}`; table-driven unit spec. |
| G-04 | FR-002, AS-03 | `CreateSiteDto` (`controller:10-13`): `origins` has min/max size but items are only `IsString`; `featuredProductIds` has no max size (`:12`); no `name`, no `theme`; unknown properties are not proven rejected; `IdentifyDto.key`/`token` are unbounded strings (`:15-18`). | Whitelisted DTOs with the limits of the spec; contract schemas in `packages/contracts`; key format `^pk_live_[A-Za-z0-9_-]{24}$` validated before any lookup; token ≤ 4 KiB. |
| G-05 | FR-004, AS-05 | No limit on sites per shop. | Store-enforced 10 per shop (conditional insert or serialised counter); `422 site_limit_reached`; concurrency test. |
| G-06 | FR-005, AS-07 | No update at all; theme and featured products can never change after creation. | `PATCH` with `expectedVersion` (conditional `UPDATE … WHERE id AND "shopId" AND version = :v`); `409 site_version_conflict`; change events by field group. |
| G-07 | FR-006, AS-08 | Featured product IDs are never checked against the shop at write time; the config read filters by `shopId` in SQL (`service:98`) but silently. | Validate with S05 R1 `getProductsByIds(ids, {shopId})` in one batch; `422 featured_product_invalid`. |
| G-08 | FR-007, AS-04 | `theme` is `Record<string,string>` (`service:17`) echoed raw in `config` (`:105`) and has no writer. | `domain/theme.ts` allowlist; validate on write; loader re-validates. |
| G-09 | FR-009, FR-010, AS-10, AS-11 | The identity secret is sealed with no context (`service:56`); no rotation, no previous secret, no way to recover from a leak except deleting the site (no delete either). | Seal with `SecretBox` context `widget-site:<siteId>` (generate the ID before insert); `rotate-secret`, `expire-previous-secret`; previous secret decided at use time from the injected clock; one-off re-seal of existing rows. |
| G-10 | FR-008, AS-12 | No delete. | `DELETE` with cache invalidation and event. |
| G-11 | FR-027, AS-39–AS-41 | `setKillSwitch` is an unconditional `UPDATE` (`service:63`), returns `204` (`controller:37`), writes no history and no event; invalidation happens after the write and `site()` keeps a per-process layer (`l1: 'always'`, 10 s, `service:76`) so other instances serve a killed site for up to 10 s. | Conditional update that only changes when the value differs, history row (`WidgetSiteChange`) and outbox event in the same transaction; `200 WidgetSiteDto`; remove the per-process layer for site records (S52 cross-instance invalidation); extend the switch to `identify`, `session`, `embed`, issued tokens. |
| G-12 | FR-030, AS-13 | CSRF behaviour of the dashboard mutations is not tested; `PUT`/`POST` rely on whatever S01's guard does. | Wire S01's CSRF check; AS-13 for every mutation route. |
| G-13 | FR-036, AS-22 | `create`/`kill` have no rate limit. | `widget.manage.shop` policy (fail-closed). |
| G-14 | FR-040, AS-54 | `WidgetSite` row has a foreign key to `Shop` (`migrations/20261001340000-widget-sites.js`, column `shopId`), so shop deletion is blocked by sites (IX.4 "foreign keys referencing another owner's table"); no `name`, `version`, previous secret, shop copy columns; no CHECK on origin count or key format; `WidgetSiteChange` does not exist and is not in `db/ownership.ts` (only `WidgetSite`, `:152`). | Expand/contract migration with `lock_timeout`: add columns and `WidgetSiteChange`, backfill `shopName`/`shopStatus`/`shopVersion` through R1 `getShopsByIds` (batches ≤ 500), drop the FK in a later step; registry entry for `WidgetSiteChange`. |

### Public API, origin binding, CORS (`api/widget.controller.ts`, `service.authorize`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-15 | FR-011, FR-012, AS-16, AS-17 | `config` and `identify` call `authorize(key ?? '', origin)` with any string; the key becomes a cache key and a query parameter unchecked (`service:72-75`); the unknown-key negative entry lasts 60 s (`:76`) and is not cleared when a site is created. | Shape-check the key first; cache unknown well-formed keys ≤ 30 s and clear on create; identical `404 widget_site_not_found` bodies. |
| G-16 | FR-013, AS-18 | The controller sets `Access-Control-Allow-Origin` by hand with `origin!` (`controller:50`, `:63`) while the global CORS middleware (`libs/infrastructure/platform/bootstrap-http.ts:34-39`) also runs, reflects any origin when `cors_allowed_origins` is unset and sets `credentials: true`; no per-site preflight, so the JSON `identify` POST fails in production unless the shop is on the global allowlist; the 403 path also relies on the global policy. | Exempt the widget route group from the global CORS policy; per-site CORS in one place (registered-origin echo, `Vary: Origin`, no credentials, exact methods and headers, `Max-Age: 600`); preflight handler; AS-18 table. |
| G-17 | FR-014, FR-015, AS-14, AS-19 | `config_` reads `Shop` and `Product` with raw SQL (`service:96`, `:98`) — IX.4 / D-12; returns `price: Number(p.price)` (`:106`, float); `IN (:ids)` has no order so the configured order is lost; archived products are not excluded; `shop?.name ?? ''` hides a missing shop. | R1 `getProductsByIds(ids, {shopId})`, order by the configured list, hide archived, `price: {amountMinor, currency}`; name from the site's shop copy; contract schema `widgetConfigSchema`. |
| G-18 | FR-016, FR-029, AS-21, AS-39 | `Cache-Control: public, max-age=60, s-maxage=60` on success only (`controller:52`); errors carry whatever default; a product-lookup failure is a plain `500`; no stale copy. | Per-response cache headers (410 → `s-maxage=30`, others `no-store`); shaped-response cache with stale-on-error 600 s; `503 service_unavailable` when no copy. |
| G-19 | FR-036, AS-22 | `config` is `skipThrottle: true` (`controller:46`); `identify` uses the **login** policy `@RateLimit('auth.login.ip')` (`:57`), so widget traffic spends the same budget as logins from that IP. | Policies `widget.config.ip` (fail-open), `widget.identify.ip`, `widget.identify.site` (fail-closed). |
| G-20 | FR-028, AS-43 | A site of a suspended or deleted shop keeps working; there is no consumer of tenancy events. | `WidgetProjectorModule` with the three consumers, version-guarded updates of `shopName`/`shopStatus`/`shopVersion`, `410` on non-`ACTIVE`; schema validation, inbox, DLQ. |
| G-21 | FR-033, FR-034, AS-44, AS-46 | Nothing seeds or updates a shop copy; no purge on shop deletion (and the FK blocks it). | Seed through R1 at creation (outside the transaction); `tenancy.shop_deleted` purge with per-site events. |

### Identity hand-off (`service.identify`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-22 | FR-018, AS-24 | `jwt.verify(..., {maxAge: 300})` (`service:124`) needs `iat` and applies library defaults for `nbf`; the extra `exp - Date.now()/1000 > 300` check uses the wall clock (`:128`) so it cannot be tested with a frozen clock; no `sub`/`jti` length limits; `email` is copied unchecked (`:131`). | Pure claims policy in `domain/handoff-claims.ts` with an injected clock and the closed reason list; signature verified first with HS256 pinned; table-driven unit spec. |
| G-23 | FR-018, AS-25 | Every failure is `UnauthorizedException` with the same message for signature errors (`:126`) but different messages for claim errors (`:128`, `:129`), so the body tells an attacker which check failed. | One body `401 identity_token_invalid`; reasons only in the log and a metric label. |
| G-24 | FR-019, AS-26, AS-27 | The single-use marker is `SET NX EX 600` (`:129`) keyed by site and `jti`; a Redis failure surfaces as `500`; the TTL is not tied to `exp`. | Marker TTL `exp + 60 s`; fail closed `503` without consuming; fallback counter; concurrent-replay test. |
| G-25 | FR-020, AS-23, AS-33 | The widget token is signed with the general `jwt_secret` (`:131`) with `typ: 'widget'`, `aud: 'widget'`, no `jti`, no `iss`; `jwt_secret` is the legacy access-token secret S01 is retiring, so tokens are not isolated. | Dedicated widget key from validated config (startup fails without); `typ: widget+jwt`, `aud: marketplace-widget-session`, `iss: marketplace`, `jti`; verifier refuses anything else. |
| G-26 | FR-022, AS-32 | No `session` route and no verifier; nothing can use the widget token. | `GET /api/widget/v1/session` and exported `WidgetSessionService.verify`. |
| G-27 | FR-031, AS-31 | No content-type enforcement, no body limit, no proof that cookies are ignored or never set. | `415` for non-JSON, `413` over 8 KiB; assert no `Set-Cookie`; ignore cookies. |
| G-28 | FR-021, AS-29 | Correct by design (no account linking) but untested. | AS-29 test (user and session counts unchanged). |
| G-29 | FR-010, AS-28 | Only one secret is ever accepted (`service:121`). | Try current, then previous while `now < previousSecretExpiresAt`. |

### Embed document and CSP (`controller.embed`, `service.frameAncestors`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-30 | FR-025, AS-34 | CSP is ``default-src 'self'; script-src 'self'; frame-ancestors …`` (`controller:79`): no nonce, no `strict-dynamic`, no `base-uri`, `object-src`, `form-action`; `default-src 'self'` is wider than needed. | Nonce per response (≥ 128 bits), the directive set of FR-025; one nonced script element; no inline code; `Cache-Control: no-store`, `nosniff`, `Referrer-Policy`. |
| G-31 | FR-025 | The HTML references `/widget/v1/app.js` (`controller:81`), a path with no `/api` prefix and no route behind it; the iframe app does not load. | Bundle URL from validated configuration (HTTPS, owned by W07). |
| G-32 | FR-024, AS-36, AS-37 | Killed site: `res.status(410).send('')` with no policy and an empty body (`controller:78`) — the global helmet header (`bootstrap-http.ts:21-24`) applies, but problem+json is not used; the unknown key goes through `site()` and the filter, which is right but untested. | Refusals via the global filter (problem+json) with `frame-ancestors 'none'`; table test over every other route (AS-36). |
| G-33 | FR-024, AS-35 | `frameAncestors` joins the stored list unsorted and unvalidated (`service:136-138`). | Pure builder in `domain/frame-policy.ts` (sorted, deduplicated, throws on non-normalised values); unit spec. |
| G-34 | FR-026, AS-37 | The key is reflected through `encodeURIComponent` (`controller:81`) — safe, but a malformed key reaches `site()`; no test with a hostile key. | Malformed keys refused before reflection; AS-37 test with `"><script>`. |

### Loader (`packages/edge-be/src/widget-loader.ts`, `packages/edge-be/src/index.ts:319-324`)

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-35 | FR-032, AS-47 | No test of the "< 5 KB" claim, of the absence of unsafe sinks, or of the headers. | `widget-loader.spec.ts` (size, single global, no `innerHTML`/`eval`/`document.write`/`'*'`, `credentials: "omit"`, headers of the route). |
| G-36 | FR-032, AS-48 | The message handler checks `event.origin` and `event.source` (good) but does not validate message shape (extra fields, non-object), the `identify` promise has no deadline, and `MarketplaceWidget` is created only at the end, after `if (!key) return`, so a shop calling `MarketplaceWidget.identify = …` on a page with no key throws. | Closed message set, 5 s identify deadline, define the global first; tests AS-48. |
| G-37 | FR-032, AS-49 | `config.products.forEach` trusts the response shape; `p.title` is used via `'Buy ' + p.title` (text only, good) but a non-array or non-string would throw inside the promise (caught by the final `catch`, but the button list may be half drawn). | Shape check (≤ 12 products, string titles, boolean `inStock`) before drawing; theme re-validation; out-of-stock buttons disabled. |
| G-38 | FR-032 | The iframe is created without `referrerpolicy` and the `allow` attribute is `payment` only (fine); `src` carries the product in the fragment (fine). | Add `referrerpolicy="strict-origin-when-cross-origin"` and `loading="eager"`; no other change. |

### Layering, tests, observability

| ID | Spec | Current state | Required change |
|---|---|---|---|
| G-39 | I.1, I.2, FR-040 | `WidgetService` (application) holds raw SQL on its own table through `@InjectConnection` (`service:41`, `:53`, `:63`, `:75`), no repository, no port, no Sequelize model; `jsonwebtoken`, `Date.now()` and `randomBytes` are used inside the application layer. | Repository port in `domain/`, adapter in `infra/` (model for `WidgetSite` and `WidgetSiteChange`); pure rules in `domain/`; clock injected. |
| G-40 | X.4 | `widget.module.ts:8` exports `WidgetService` and imports `AuthModule`/`CacheModule` only; there is no `WidgetProjectorModule`; `index.ts` exports `WidgetModule` only. | Export `WidgetModule`, `WidgetProjectorModule`, `WidgetSessionService`, `WidgetPrincipal`, event contract types; stop exporting `WidgetService`. |
| G-41 | FR-037, FR-038, AS-51, AS-53 | No events, no contract schemas in `packages/contracts` for widget, errors are Nest exceptions. | Schemas listed in AS-53; `developer_platform.widget_site_changed` through `outbox.append`; problem+json `code`s. |
| G-42 | FR-039, AS-52 | No metrics; the service logs nothing about widget decisions. | Counters of AS-52; structured logs without secrets, tokens, e-mails; test searching the captured log output. |

## 2. Debt-register rows touching this capability

| Row | Status | What it means here | IX.7 mechanism that replaces it |
|---|---|---|---|
| D-6 (I.2 layering) | open | `application/widget.service.ts` issues SQL itself (G-39) and the controller imports the service directly (fine) | repository port + adapter (not an IX.7 matter); done with G-39 |
| D-7 (IX.4 foreign `*Model` exports) | open | `widget.e2e-spec.ts` imports `ShopModel` from `@app/domains/tenancy` (`:11`, `:15`, `:45`) to create shops | tenancy's exported services and the shared fixture helpers; no model import once D-7 is paid for tenancy |
| D-8 (X.4 barrels export internals) | open, small here | `widget.module.ts:8` exports `WidgetService`; `index.ts` exports nothing else of the widget | export only module(s), `WidgetSessionService` (R1) and DTO/event types (G-40) |
| D-12 (IX.4 raw SQL on foreign tables) | open | developer-platform reads `Shop` (`service:96`) and `Product` (`service:98`) in the widget; `ShopOrder`, `BisOrder`, `BisOrderItem`, `ShopMembership` belong to S42/S43 | `Product` → **R1** `ProductQueryService.getProductsByIds(ids, {shopId})` (S05); `Shop` → **R3** copy fed by `tenancy.shop_updated` / `tenancy.shop_status_changed`, seeded once by **R1** `ShopQueryService.getShopsByIds` (S03) |
| D-1…D-5, D-9, D-13 | resolved | no action | — |
| D-10, D-11, D-14, D-15, D-16, D-17 | open, not this domain's widget code | no widget file is involved | — |

## 3. `check:table-ownership` lines for this domain (widget files)

Derived from reading the code because the command could not be run (see top of file). The implementation agent runs it and reconciles.

| Kind | Where | Table or model | Mechanism that replaces it |
|---|---|---|---|
| SQL | `application/widget.service.ts:96` | `Shop` | R3 copy on `WidgetSite` (`shopName`, `shopStatus`, `shopVersion`) + R1 `getShopsByIds` at creation and backfill |
| SQL | `application/widget.service.ts:98` | `Product` | R1 `getProductsByIds(ids, {shopId})` |
| MODEL | `widget.e2e-spec.ts:11,15,45` | `ShopModel` (tenancy) | shared fixture helpers and tenancy's exported services |
| FK (not reported by the script, violates IX.4) | `migrations/20261001340000-widget-sites.js` | `WidgetSite.shopId → Shop(id)` | plain ID column, no FK; expand/contract |
| own table, raw SQL in application layer | `application/widget.service.ts:53,63,75` | `WidgetSite` | owned: move behind a repository (D-6) |
| registry | `db/ownership.ts:152` | `WidgetSite` → `domain:developer-platform` | add `WidgetSiteChange` |

Other developer-platform lines (`api_keys`, `public-catalog`, `public-orders`, webhook router and deliverer) belong to S42 and S43 and are listed in their `gaps.md` files.

## 4. Implementation order (suggested)

1. Run `check:table-ownership`; add the S03 permission request and the S50–S54 facilities as stubs behind their ports (they may land in other capabilities first).
2. Migration (expand), registry entry, repository and models (G-14, G-39), pure rules with unit specs (origin, claims, theme, frame policy, shop copy).
3. Dashboard routes with RBAC, limits, rotation, kill switch and history (G-01–G-13).
4. Public routes: CORS group, config via R1 and the shop copy, identify, session, embed (G-15–G-34).
5. Consumers and the shop-copy seed (G-20, G-21), backfill, contract migration (drop FK).
6. Loader changes and spec (G-35–G-38).
7. Split and delete the old e2e; run all suites; `check:*` with `--strict`.
