---
id: provider-default-role
title: Provider default role
kind: term
status: draft
aliases: [default role]
defined_for: S03-shops-rbac
rules_hash: 925da9448e3c
---
# Provider default role
## Definition
The provider default role is the [shop role](shop-role.md) that is part of a shop's [SSO configuration](shop-sso-config.md). It is given to a user who joins the shop by signing in through that provider. The user becomes a member with [`source: sso`](membership-removal-source.md) and this role. This happens only while SSO is enabled, the shop is [`ACTIVE`](shop-status.md) and a [seat](seat.md) is free. A user who is already a member keeps their current role. The default role is never applied to them.

## Example
Shop `acme` (illustrative) has the default role `STAFF` (illustrative). A new user signs in through acme's provider, and the system consumes [`identity.federated_identity_linked`](federated-identity.md). The user becomes a `STAFF` member with `source: sso`. If that member is removed later, a [redelivered event ↗](../sw-external-terms.md#at-least-once-delivery) does not add them again.

## Known gaps
- The spec does not say which roles are allowed as the default role. An invite cannot grant `OWNER`, but the spec does not say whether the same limit applies here.
- The spec does not say what happens to the sign-in when no seat is free. It only says that no membership is created.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): R-23
- [member-provisioning](member-provisioning.md)
- [put-shops-sso](put-shops-sso.md)
- [seat](seat.md)
- [shop-role](shop-role.md)
- [shop-sso-config](shop-sso-config.md)
<!-- used-by:end -->
