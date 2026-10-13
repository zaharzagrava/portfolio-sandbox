---
id: caller-scoping
title: Caller scoping
kind: term
status: draft
aliases: [scoped to the caller]
defined_for: S02-mfa-oidc
rules_hash: 6afdae4d39dd
---
# Caller scoping
## Definition
Caller scoping means the [identity endpoints](linked-identity.md) only see and change the identities of the signed-in caller. Listing returns only the caller's own [linked identities](linked-identity.md). Unlinking finds the identity by its id and by the caller together. Another user's identity is therefore treated exactly like a missing one, with [`identity_not_found`](identity-not-found.md).

## Example
A user with two linked identities calls `GET /auth/identities` and sees only those two, newest first (S02.B-20). Calling `DELETE /auth/identities/:identityId` with someone else's id answers `404 identity_not_found` (S02.R-24).

## Used by
<!-- used-by:start -->
- [S02](../capabilities/S02-mfa-oidc.md): R-24
- [S13](../capabilities/S13-payment-intents.md): B-05
- [linked-identity](linked-identity.md)
<!-- used-by:end -->
