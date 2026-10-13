---
id: password-reset-link-invalidation
title: Reset link invalidation
kind: term
status: draft
aliases: [older links]
defined_for: S01-auth-sessions
rules_hash: 0a7b5518b4a3
---
# Reset link invalidation
## Definition
When a new password-reset request is accepted for an account, every [reset link](password-reset-token.md) sent earlier for that account stops working. Only the newest link can be used to confirm a reset. This is design intent (not stated in the spec): an old link left in an inbox cannot be used later.

## Example
A user asks for a reset at 10:00 and again at 10:05 (illustrative times). The link from the 10:00 email is now refused at `POST /auth/password-reset/confirm`. Only the 10:05 link works.

## Known gaps
- The spec does not say which error a confirm with an invalidated link returns, or whether it matches the error for an [expired or unknown token](invalid-reset-token.md).
- The spec does not say whether a successful confirm also invalidates other outstanding links. [Single use](password-reset-token.md) only covers the token that was used.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-39
- [invalid-reset-token](invalid-reset-token.md)
- [password-reset-token](password-reset-token.md)
- [password-reset](password-reset.md)
<!-- used-by:end -->
