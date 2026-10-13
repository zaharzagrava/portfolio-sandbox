---
id: parse-return-path
title: parseReturnPath
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# parseReturnPath
## Definition
`parseReturnPath` is the domain function that checks a [return path](return-path.md) before the system uses it. It accepts only a relative path that starts with exactly one `/`. It refuses [protocol-relative ↗](../sw-external-terms.md#protocol-relative-url), backslash, scheme and control-character values. It lives in `packages/backend/libs/domains/identity/domain/return-path.ts`. Design intent (not stated in the spec): it stops the [OIDC callback](oidc-callback.md) from redirecting the user to a foreign site, which is known as an [open redirect ↗](../sw-external-terms.md#open-redirect).

## Example
A visitor calls `POST /auth/oidc/google/start` with a [`returnTo`](return-to.md) value. Illustrative values:
```
/account/orders          accepted
//evil.example           refused (protocol-relative)
/\evil.example           refused (backslash)
https://evil.example     refused (scheme)
```

## Known gaps
- The spec does not say what `parseReturnPath` returns for a refused value: an error, an empty result or a default path.
- The spec does not say whether a refused `returnTo` fails the [OIDC start](oidc-start.md) call or lets the flow continue with a fallback.
- Not confirmed in the code: whether the callback runs `parseReturnPath` a second time before it redirects.

## Used by
<!-- used-by:start -->
- [oidc-callback](oidc-callback.md)
- [oidc-start](oidc-start.md)
- [return-path](return-path.md)
<!-- used-by:end -->
