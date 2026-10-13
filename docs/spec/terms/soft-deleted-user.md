---
id: soft-deleted-user
title: Soft-deleted user
kind: term
status: draft
aliases: [soft-deleted linked user]
defined_for: S02-mfa-oidc
rules_hash: de429a9ea2db
---
# Soft-deleted user
## Definition
A [soft-deleted](soft-delete.md) user is an account marked as deleted while its record stays in the store. Its [linked identities](linked-identity.md) still resolve to it. Even so, a Google login to such a user is refused with [`account_unavailable`](account-unavailable.md), and no session is issued. An [MFA challenge](mfa-challenge.md) that belongs to a deleted user is also rejected as [`invalid_mfa_challenge`](mfa-challenge.md).

## Example
Google subject `g-1` is linked to a user who has been soft-deleted. [The callback](oauth-callback.md) finds the link, then redirects with `error=account_unavailable` instead of signing the user in.

## Known gaps
- The spec does not say which capability soft-deletes users, or how it does so.
- The spec does not say whether e-mail matching during a first Google login skips soft-deleted accounts or matches them.

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): B-18
- [account-unavailable](account-unavailable.md)
- [linked-identity](linked-identity.md)
- [mfa-challenge](mfa-challenge.md)
- [oauth-callback](oauth-callback.md)
- [soft-delete](soft-delete.md)
<!-- used-by:end -->
