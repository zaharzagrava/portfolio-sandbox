---
id: platform-role
title: Platform role
kind: term
status: draft
aliases: []
defined_for: S04-kyc-onboarding
rules_hash: 286dff4e7622
---
# Platform role
## Definition
A platform role is a role a user holds across the whole platform, not inside one shop. It is separate from a [shop role](shop-role.md) and from [shop permissions](permission.md) such as `shop.manage`. In [KYC onboarding ↗](../sw-external-terms.md#kyc), the platform roles `ADMIN` and `MODERATOR` are the only ones allowed to use the moderator review endpoints. A caller without one of these roles gets [`403 insufficient_role`](insufficient-role.md). Holding a platform role does not override the conflict-of-interest check: a reviewer who is also a shop member gets `403 conflict_of_interest`.

## Example
A user with the `MODERATOR` platform role lists open review tasks and gets them back. A seller who only holds `shop.manage` on their shop calls the same endpoint and gets `403 insufficient_role`.

## Known gaps
- The spec does not say which platform roles exist besides `ADMIN` and `MODERATOR`.
- The spec does not say how a platform role is granted or how it reaches the backend on a request.
- The spec does not say whether `ADMIN` and `MODERATOR` have different powers on the review endpoints.

## Used by
<!-- used-by:start -->
- [moderator](moderator.md)
- [permission](permission.md)
- [shop-role](shop-role.md)
<!-- used-by:end -->
