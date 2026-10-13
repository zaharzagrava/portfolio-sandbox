---
id: breached-password
title: Breached password
kind: term
status: draft
aliases: [breached]
defined_for: S01-auth-sessions
rules_hash: 1dc69f7c2833
---
# Breached password
## Definition
A breached password is a password found in a list of known leaked passwords. During registration, [S01](../capabilities/S01-auth-sessions.md) checks the password against this list. A match gives [`422 weak_password`](weak-password.md) and nothing is stored. The answer is the same for new and existing addresses, so the check does not reveal whether an account exists. If the check times out or fails, registration continues and the [`auth_breach_check_skipped_total`](auth-breach-check-skipped-total.md) metric goes up.

## Example
Someone registers with a password from a public leak, such as `password1234` (illustrative). The response is `422 weak_password`, and no account or event is created.

## Known gaps
- The spec does not say which breach source or service is used, or how the password is sent to it, for example by [hash prefix ↗](../sw-external-terms.md#one-way-hash).
- The spec does not say whether the breach check also runs on password reset (`/auth/password-reset/confirm`) or at login.
- Not confirmed in the code: which component does the check. Only [`passwordProblem`](password-problem.md) is linked, and the code does not show that it calls the breach check.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-04, B-05
- [weak-password](weak-password.md)
<!-- used-by:end -->
