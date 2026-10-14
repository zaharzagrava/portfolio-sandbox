# Contract: public widget API (`/api/widget/v1`) and loader

Anonymous, no cookies read or set, per-site CORS (the global CORS policy does not apply). Order of checks on every route: key shape → site lookup → `Origin` → kill switch / shop status → everything else. A missing, `null`, repeated or unregistered `Origin` → `403 origin_not_allowed`. Errors are problem+json with `code` and `requestId` and carry `Content-Security-Policy: frame-ancestors 'none'`; malformed and unknown keys give identical `404 widget_site_not_found` bodies.

CORS on success and on refusals of registered origins: `Access-Control-Allow-Origin: <registered origin>`, `Vary: Origin`, never `Allow-Credentials`; preflight `OPTIONS` of config/identify/session only for registered origins: methods `GET` (config, session) / `POST` (identify), headers `Content-Type, Authorization`, `Max-Age: 600`.

| Route | Request | Success | Errors / notes |
|---|---|---|---|
| `GET config?key=` | | `200 widgetConfigSchema {version:"v1", shop:{name}, theme, products:[{id,title,price:{amountMinor,currency},inStock}], checkoutUrl}`; `Cache-Control: public, max-age=60, s-maxage=60`, `Vary: Origin`; products from `getProductsByIds(ids,{shopId})`, configured order, archived hidden | `410 widget_disabled` (`s-maxage=30`), all other errors `no-store`; `503 service_unavailable` when lookup fails and no stale copy (stale ≤ 600 s served otherwise); `429` from `widget.config.ip` (fail-open) |
| `POST identify` | `application/json` ≤ 8 KiB `{key, token ≤ 4 KiB}` | `200 {widgetToken, expiresIn: 900, customer:{id, email: string|null}}` | `401 identity_token_invalid` (one body for every cause), `415`, `413`, `503` (single-use store down, token not consumed), `429` (`widget.identify.ip`, `widget.identify.site`, fail-closed) |
| `GET session` | `Authorization: Bearer <widget token>` | `200 widgetSessionSchema {site:{id}, customer:{id,email}, expiresAt}` | `401 widget_token_invalid`, `410 widget_disabled` |
| `GET embed?key=` | | `200 text/html`; `Content-Security-Policy: default-src 'none'; script-src 'nonce-<n>' 'strict-dynamic'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors <sorted registered origins>`; `Cache-Control: no-store`; `X-Content-Type-Options: nosniff`; no `X-Frame-Options`; one nonced script element, bundle from `WIDGET_APP_BUNDLE_URL` | refusals are problem+json with `frame-ancestors 'none'`; the key is echoed only if well-formed and encoded |

Hand-off token (shop backend): HS256, secret = site `identitySecret` (current, or previous until `previousSecretExpiresAt`), claims `{iss: <publishableKey>, aud:"marketplace-widget", sub ≤128, email? ≤254 well-formed, jti 8–128, exp ≤ now+300 s, nbf skew 30 s, iat skew 60 s}`; single use per site (marker TTL `exp`+60 s).

Widget token: `typ: widget+jwt`, `aud: marketplace-widget-session`, `iss: marketplace`, `jti`, 900 s, signed with `widget_token_key`; refused by every other verifier and vice versa.

`WidgetSessionService.verify(token, origin?) → WidgetPrincipal | null` (R1, never throws): same decision as `GET session`.

Every other response of the application carries `frame-ancestors 'none'` (AS-36 route table).

## Loader (`packages/edge-be`, `GET /widget/v1/loader.js`)

≤ 5 KiB, one global `MarketplaceWidget {version:"v1", identify}` defined first, no `innerHTML`/`eval`/`document.write`/`'*'` target, `fetch(..., {credentials:"omit"})`, config shape check (≤ 12 products, string titles, boolean `inStock`, theme re-validated), iframe with `referrerpolicy="strict-origin-when-cross-origin"`, closed message set `marketplace:close`, `marketplace:need-identity`, `marketplace:identity {token}` accepted only when `event.origin` equals the embed origin and `event.source` is the iframe window, identify deadline 5 s, every failure renders nothing and throws nothing.

W07 bundle address: `WIDGET_APP_BUNDLE_URL`, default `/widget/v1/app.js`.
