# Contract — security headers and CSP (`lib/security/*`, `proxy.ts`)

`buildCsp({ nonce, pathname, isDev, hosts }): string`, pure. Directives (spec AS-16, AS-18):

| Directive | Value |
|---|---|
| `default-src` | `'self'` |
| `script-src` | `'self' 'nonce-<N>' 'strict-dynamic'` (+ `'unsafe-eval'` if `isDev`); on `/checkout/pay/*` + `PAYMENT_PROVIDER_HOSTS` |
| `style-src` | `'self' 'nonce-<N>'`; `style-src-attr 'unsafe-inline'` |
| `font-src` | `'self'` |
| `img-src` | `'self' data: blob:` + `MEDIA_HOST` + `MAP_TILE_HOST` (when configured) |
| `media-src` | `'self' blob:` + `VIDEO_HOST` |
| `connect-src` | `'self'` (+ `ws:`/`wss:` of this origin in dev only) + `MAP_TILE_HOST` and `VIDEO_HOST` (MapLibre and hls.js load with `fetch`); on `/checkout/pay/*` + payment hosts |
| `worker-src` | only when a map tile or video host is configured: `'self' blob:` (MapLibre's worker) |
| `frame-src` | `'none'`; on `/checkout/pay/*` + payment hosts |
| `object-src` `frame-ancestors` | `'none'` |
| `base-uri` `form-action` | `'self'` |
| `upgrade-insecure-requests` | production only |
| `report-uri` / `report-to` | `/api/csp-reports` (`Reporting-Endpoints: csp-endpoint="/api/csp-reports"`) |

Nonce: ≥ 128 random bits, base64, new per request. `proxy.ts` matcher excludes static assets, `health`, `widget`, `api`, prefetches; it sets request and response headers and makes no redirect or status decision.

Static headers (all responses): `X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`; `Referrer-Policy: strict-origin-when-cross-origin` (exactly `no-referrer` for `/reset-password` and `/invites/*`); `Permissions-Policy: camera=(), microphone=(), payment=(), geolocation=(self)`; `Cross-Origin-Opener-Policy: same-origin-allow-popups`; production `Strict-Transport-Security: max-age=63072000; includeSubDomains`; no `X-Powered-By`. `Cache-Control: no-store` on `/dashboard/**`, `/account/**`, `/checkout/**`, `/cart`, `/chat`, `/admin/**`, `/invites/**`.
