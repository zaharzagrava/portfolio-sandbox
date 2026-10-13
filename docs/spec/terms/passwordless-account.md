---
id: passwordless-account
title: Passwordless account
kind: term
status: draft
aliases: [passwordless]
defined_for: S01-auth-sessions
rules_hash: 0a7b5518b4a3
---
# Passwordless account
## Definition
A passwordless account is an account that exists but has no password stored. On a password-reset request it is treated like an [unknown address](identical-registration-response.md): the answer is the same [`202` ↗](../sw-external-terms.md#http-202-accepted) and no message is sent. Because of this, a caller cannot tell from the response whether the account exists or how it signs in. This is design intent (not stated in the spec): it follows S01's goal of resisting [account enumeration ↗](../sw-external-terms.md#account-enumeration).

## Example
A user who has no password asks for a reset:
```
POST /auth/password-reset/request  →  202
```
No message is sent. The response is byte-for-byte what an unknown address would get.

## Known gaps
- The spec does not say how an account ends up without a password. It might be sign-in only through a [linked identity](linked-identity.md), but that is not confirmed.
- The spec does not say how a passwordless user can add a password, if they can at all.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-39
- [identical-registration-response](identical-registration-response.md)
- [linked-identity](linked-identity.md)
- [password-reset](password-reset.md)
<!-- used-by:end -->
