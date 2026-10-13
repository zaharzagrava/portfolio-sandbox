---
id: api-bff-endpoints
title: /api/bff/* endpoints
kind: term
status: draft
aliases: [/api/bff/*, api/bff]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# /api/bff/* endpoints
## Definition
The `/api/bff/*` endpoints are the [BFF ↗](../sw-external-terms.md#bff)'s REST routes. They cover the product page and the browser session: login, MFA completion, the current session, logout and refresh. [Web rewrites](web-rewrite.md) send these paths, and `/api/graphql`, to the BFF. This keeps the [`__Host-` cookies](host-access-cookie.md) on one origin. The cookie-authenticated POST routes need the [CSRF token ↗](../sw-external-terms.md#csrf-token), while login uses an [origin check](origin-allow-list.md) instead.

## Example
`GET /api/bff/product-page/3f6c…` (illustrative UUID) returns the product page. `POST /api/bff/session/logout` with a valid `X-CSRF-Token` answers `204` and clears the cookies.

## Known gaps
- The spec does not describe the [`/api/bff/f/*` forwarder](bff-forwarder.md), which is reached through a web rewrite.
- The spec does not list `POST /api/bff/session/refresh`, and no test covers it. It exists only in the controller.

## Used by
<!-- used-by:start -->
- [bff-forwarder](bff-forwarder.md)
- [host-access-cookie](host-access-cookie.md)
- [origin-allow-list](origin-allow-list.md)
- [payload-too-large](payload-too-large.md)
- [web-rewrite](web-rewrite.md)
<!-- used-by:end -->
