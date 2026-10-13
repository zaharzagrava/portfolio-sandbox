---
id: breached-password-check
title: Breached-password check
kind: term
status: draft
aliases: [breached password]
defined_for: S01-auth-sessions
rules_hash: 7bc2f5317e34
---
# Breached-password check
## Definition
The breached-password check runs during registration. It asks whether the chosen password is known to have leaked in a public breach. If it has, the request fails with [weak_password](weak-password.md) whether or not the address is already registered. If the check times out or fails, registration continues without it and [auth_breach_check_skipped_total](auth-breach-check-skipped-total.md) goes up. Design intent (not stated in the spec): an outage in the breach source should not block sign-ups.

## Example
`POST /auth/register` with a password that appears in breach data returns `422 weak_password`, and nothing is stored (S01.B-05). If the breach source does not answer within 800 ms, the same request is accepted with `202` and the counter goes up by one.

## Known gaps
- The spec does not say which breach source or dataset is queried, or how the password is sent to it (for example, as a hash prefix).
- The spec does not say whether the check also runs on password reset or password change.
- Not confirmed in the code: whether the check is part of [`passwordProblem`](password-problem.md) in `packages/backend/libs/domains/identity/domain/password-policy.ts` or lives in a separate component.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-05
- [auth-breach-check-skipped-total](auth-breach-check-skipped-total.md)
- [password-problem](password-problem.md)
- [post-auth-register](post-auth-register.md)
- [weak-password](weak-password.md)
<!-- used-by:end -->
