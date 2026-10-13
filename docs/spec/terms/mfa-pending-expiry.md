---
id: mfa-pending-expiry
title: MFA pending expiry
kind: term
status: draft
aliases: [15-minute pending expiry, pending expiry]
defined_for: S02-mfa-oidc
rules_hash: 2c3f7a990300
---
# MFA pending expiry
## Definition
The pending expiry is the deadline for [confirm](mfa-confirm.md)ing an [enrolment](mfa-enrolment) that has started. After the deadline, the [`pending`](mfa-state.md) state is reported as `none`, and [confirm](mfa-confirm) returns [`mfa_not_pending`](mfa-not-pending). Each re-[enrolment](mfa-enrolment.md) while `pending` replaces the secret and sets a new expiry. A code from the replaced secret cannot confirm, even before the new deadline.

## Example
At 10:00 a user enrols, and at 10:05 they enrol again, so the deadline is reset (the times are illustrative). A code from the first secret is now rejected. If no code from the second secret is confirmed within 15 minutes of 10:05, [`GET /auth/mfa`](mfa-management-endpoint.md) shows `none`, and confirm returns `409 mfa_not_pending`.

## Known gaps
- The spec does not say whether an expired pending secret is removed from the store or only treated as `none` when read.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-03
- [mfa-confirm](mfa-confirm.md)
- [mfa-enrolment](mfa-enrolment.md)
- [mfa-state](mfa-state.md)
- [second-factor-model](second-factor-model.md)
<!-- used-by:end -->
