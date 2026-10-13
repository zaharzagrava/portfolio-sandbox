---
id: mfa-not-pending
title: mfa_not_pending (409)
kind: term
status: draft
aliases: [mfa_not_pending]
defined_for: S02-mfa-oidc
rules_hash: e3b0c44298fc
---
# mfa_not_pending (409)
## Definition
`mfa_not_pending` is the [conflict error](conflict-error) that [confirm](mfa-confirm) returns when there is no [live enrolment](mfa-enrolment.md) to [confirm](mfa-confirm.md). That happens when the [MFA state](mfa-state) is `none` or `enabled`, or when the [pending expiry](mfa-pending-expiry) has passed. It is also the answer the losing request gets when [two confirms race with the same code](optimistic-concurrency.md). In every case nothing changes.

## Example
A client retries `POST /auth/mfa/confirm` after the first call already succeeded. The retry gets `409` with [error code](error-code) `mfa_not_pending`, and no second set of recovery codes is issued.

## Used by
<!-- used-by:start -->
- [mfa-confirm](mfa-confirm.md)
- [mfa-enrolment](mfa-enrolment.md)
- [optimistic-concurrency](optimistic-concurrency.md)
<!-- used-by:end -->
