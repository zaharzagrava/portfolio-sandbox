# Contract — widget checkout application messages (S44 iframe side)

| Message | Direction | Rule |
|---|---|---|
| `marketplace:need-identity` | iframe → host page | posted to `window.parent` with the registered host origin as `targetOrigin`; never `"*"` |
| `marketplace:identity { token }` | host page → iframe | accepted only if `event.source === window.parent` and `event.origin === registeredHostOrigin`; otherwise ignored silently, as are malformed payloads |
| `marketplace:close` | iframe → host page | on **Close** or Escape, same `targetOrigin` rule |

States: "Checking your details…" (`aria-busy`) → "Signed in as {email}" (S44 `identify`, e-mail as text) · "Continue as guest" · failure text "We couldn't open checkout. Close this window and try again." (`422`, `410`, `403`, `404` map to it).

Bundle: `GET {WIDGET_APP_BUNDLE_URL}` (default `/widget/v1/app.js`): `Content-Type: application/javascript`, `Cache-Control: public, max-age=31536000, immutable`, `Cross-Origin-Resource-Policy: cross-origin`, `X-Content-Type-Options: nosniff`; no `eval`.
