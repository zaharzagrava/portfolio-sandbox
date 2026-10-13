---
id: bff-forwarder
title: /api/bff/f/* forwarder
kind: term
status: draft
aliases: [/api/bff/f/*]
defined_for: S48-bff
rules_hash: 7383dde7625f
---
# /api/bff/f/* forwarder
## Definition
The `/api/bff/f/*` forwarder is a group of paths under the `/api/bff/` prefix. A routing rule in the web front end sends these paths to the [BFF ↗](../sw-external-terms.md#bff). The specification calls it a "forwarder" but does not describe it, and it is not one of the BFF's specified entry points. From its name, it probably passes requests through to a [domain API](domain-api-origin.md), but this is a guess (design intent, not stated in the spec).

## Example
A browser request whose path starts with `/api/bff/f/` goes to the BFF through the web rewrite, the same way `/api/bff/session` does. The spec gives no concrete path or response for it.

## Known gaps
- The spec does not say what the forwarder forwards, to which upstream, or which methods it accepts.
- The spec does not say whether the forwarder follows the header and token rules, which strip [identity headers](identity-headers.md) and send tokens only to the configured domain-API origin, or the [CSRF check ↗](../sw-external-terms.md#csrf-token) for cookie-authenticated POSTs.
- Not confirmed in the code: the verified notes for `packages/backend/libs/composition/bff` do not mention the forwarder, and no test covers it.

## Used by
<!-- used-by:start -->
- [W01](../capabilities/W01-auth-account.md): R-02
- [api-bff-endpoints](api-bff-endpoints.md)
- [bff-composition-library](bff-composition-library.md)
- [domain-api-origin](domain-api-origin.md)
- [host-ref-cookie](host-ref-cookie.md)
- [identity-headers](identity-headers.md)
- [web-rewrite](web-rewrite.md)
<!-- used-by:end -->
