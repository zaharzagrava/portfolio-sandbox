---
id: password-problem
title: passwordProblem
kind: term
status: draft
aliases: [password policy]
defined_for: S01-auth-sessions
rules_hash: 6878d8d4e806
---
# passwordProblem
## Definition
`passwordProblem` is a function in the identity domain's password policy, and rule S01.R-04 points to it. It checks a chosen password against the password rules. Those rules are the allowed length range and a ban on using the account's own email address as the password. Its name suggests it reports what is wrong with a password rather than simply passing or failing it. That reading comes from the name only and has not been confirmed in the code. The address it compares against is the normalised one from [`normalizeEmail`](normalize-email.md) in the same file.

## Example
`POST /auth/register` with the email `" New@Example.COM "` and the password `new@example.com` breaks S01.R-04, because the password equals the normalised address. A password that is long enough and is not the address passes this rule. It can still fail the [breached-password check](breached-password-check.md) with [`422 weak_password`](weak-password.md), and that happens whether or not the address is already registered.

## Known gaps
- The spec does not say what `passwordProblem` returns, or which error a password that is too short or equals the address gets. The spec only gives a code for breached passwords (`422 weak_password`). S01.R-13 gives `400` for an overlong password, but it does not say whether that check is this function or request validation.
- Not confirmed in the code: whether `passwordProblem` calls the breached-password check itself, or whether that check is a separate step in [`RegistrationService`](registration-service.md).
- The spec does not say whether `passwordProblem` also runs on `POST /auth/password-reset/confirm` or on a password change.

## Used by
<!-- used-by:start -->
- [breached-password-check](breached-password-check.md)
- [normalize-email](normalize-email.md)
- [post-auth-register](post-auth-register.md)
<!-- used-by:end -->
