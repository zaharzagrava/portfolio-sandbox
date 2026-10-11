# W07 — Data model

The shell persists nothing on the server. These are in-memory or build-time shapes.

## Entities

| Entity | Fields | Rules |
|---|---|---|
| `Config` (`lib/config.ts`) | `siteUrl`, `apiUrl`, `bffUrl`, `sseUrl`, `publicApiUrl`, `mediaHosts[]`, `videoHosts[]`, `mapTileHost?`, `paymentProviderHosts[]`, `widgetAppBundleUrl`, `sourceCodeUrl?`, `allowedOrigins[]`, `isDev` | hosts exact `https://host[:port]`; no wildcard; production requires `https` `siteUrl`; `sourceCodeUrl` ignored (logged once) unless `https:` |
| `CspInput` | `nonce`, `pathname`, `isDev`, `hosts` | `buildCsp(input): string`, pure |
| `SecurityHeaders` | `staticSecurityHeaders[]`, `noReferrerPaths[]`, `noStorePaths[]` | one effective `Referrer-Policy`; `noStorePaths` = robots disallow list (+ `/api/`) |
| `Problem` (W01) | `status`, `code`, `errors[]`, `retryAfterSeconds`, `requestId` | `ErrorState` text from `status`/`code` only |
| `PageName` | route template string ≤ 500 chars | never contains id, token, query, fragment |
| `OpenApiDocument` | `openapi` (3.x), `info`, `paths`, `tags?`, per-operation `x-scope`/`security`, `deprecated`, `Sunset` info | validated by zod before use; failure → unavailable state |
| `WidgetMessage` | `marketplace:need-identity` · `marketplace:identity {token}` · `marketplace:close` | identity accepted only if `event.source === window.parent` and `event.origin === registeredHostOrigin` |
| `ToastItem` | `kind`, `text`, `action?` | text only |

## State transitions

- Offline notice: `online` → (offline event) `offline` → (online event) `back-online` (3 s) → `online`.
- Mobile menu: `closed` ⇄ `open`; also `open → closed` on route change.
- Search row (mobile): `closed` ⇄ `open`; closes on Escape, close button, result, route change.
- Error boundary: `ok → failed → (Try again) → ok | failed`; focus to heading on each `failed`.
- Docs reference: `loading → loaded | unavailable → (Try again) → loading`.
- Widget app: `checking → signed-in | guest | failed`.

## Client leaves (the only `"use client"` files of the shell)

`mobile-menu`, `theme-control`, `search-row`, `offline-notice`, `route-focus`, `page-view`, `error.tsx`, `global-error.tsx`, `ErrorState`, docs `reference`, `checkout-app`, `lib/providers.tsx`. Enforced by `app/boundaries.test.ts`.

## Browser storage written by the app (checked against `/privacy` by `app/privacy/cookies.test.ts`)

`lib/browser-storage-keys.ts`: theme key (`localStorage`), anonymous visitor cookie (W02), `__Host-bff-csrf` (W01), session cookie (HttpOnly, server-set).
