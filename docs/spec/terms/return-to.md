---
id: return-to
title: returnTo
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# returnTo
## Definition
`returnTo` is the front-end path that a visitor passes to the [OIDC start call](oidc-start.md). After sign-in, the visitor is sent back to this path. [`parseReturnPath`](parse-return-path.md) accepts only a relative path that starts with exactly one `/`. It refuses [protocol-relative ↗](../sw-external-terms.md#protocol-relative-url) values, backslashes, schemes and control characters. This rule prevents an [open redirect ↗](../sw-external-terms.md#open-redirect) to another site: design intent (not stated in the spec).

## Example
```
returnTo: "/orders/123"            accepted (illustrative path)
returnTo: "//evil.example"         refused (protocol-relative)
returnTo: "https://evil.example"   refused (scheme)
```

## Known gaps
- The spec does not say whether `returnTo` travels in the request body or the query string.
- The spec does not say whether a refused value causes an error response or is quietly replaced with a default path.
- The spec does not say where `returnTo` is stored between start and [callback](oidc-callback.md).

## Used by
<!-- used-by:start -->
- [oidc-callback](oidc-callback.md)
- [oidc-start](oidc-start.md)
<!-- used-by:end -->
