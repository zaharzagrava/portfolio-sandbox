---
id: return-path
title: Return path
kind: term
status: draft
aliases: [return paths]
defined_for: S02-mfa-oidc
rules_hash: 1c5c30f4e3f0
---
# Return path
## Definition
The return path is where the front end should send the user after an [OIDC login ↗](../sw-external-terms.md#oidc). It is passed as [`returnTo`](return-to.md) when the flow starts. It is accepted only as a relative path that starts with exactly one `/`. [Protocol-relative ↗](../sw-external-terms.md#protocol-relative-url), backslash, scheme and control-character values are refused. Parsing is done by [`parseReturnPath`](parse-return-path.md) in `packages/backend/libs/domains/identity/domain/return-path.ts`. Design intent (not stated in the spec): the strict form prevents an [open redirect ↗](../sw-external-terms.md#open-redirect) to a foreign site.

## Example
Illustrative values:
```
/account/orders          accepted
//evil.example           refused (protocol-relative)
/\evil.example           refused (backslash)
https://evil.example     refused (scheme)
```

## Known gaps
- The spec does not say whether a refused value fails the start call or falls back to a default path.
- The spec does not say how the return path is stored during the flow or how it is combined with the [front-end origin](front-end-origin.md) on redirect.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-20
- [W01](../capabilities/W01-auth-account.md): R-05, B-06
- [front-end-origin](front-end-origin.md)
- [login-href](login-href.md)
- [oidc-start](oidc-start.md)
- [parse-return-path](parse-return-path.md)
<!-- used-by:end -->
