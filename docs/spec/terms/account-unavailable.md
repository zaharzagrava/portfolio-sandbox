---
id: account-unavailable
title: account_unavailable
kind: term
status: draft
aliases: []
defined_for: S02-mfa-oidc
rules_hash: 867ab451049c
---
# account_unavailable
## Definition
`account_unavailable` is an [OIDC login error code](oidc-login-error.md). [The callback](oidc-callback.md) sends it when the user that the login resolves to cannot sign in. The case named in the spec is a [soft-deleted linked user](soft-deleted-user.md). [No session is issued](session-lifetime.md), and the reason is not explained any further to the visitor.

## Example
A soft-deleted user's Google login completes at `GET /auth/oidc/google/callback`, which answers:
```
HTTP/1.1 302 Found
Location: https://shop.example/login?error=account_unavailable   (origin and path illustrative)
```

## Known gaps
- The spec does not say whether other blocked states (for example a suspended user) also produce `account_unavailable`.

## Used by
<!-- used-by:start -->
- [account-slot](account-slot.md)
- [anonymous-state](anonymous-state.md)
- [oidc-callback](oidc-callback.md)
- [oidc-login-error](oidc-login-error.md)
- [session-lifetime](session-lifetime.md)
- [soft-deleted-user](soft-deleted-user.md)
<!-- used-by:end -->
