---
id: last-owner
title: last_owner (409)
kind: term
status: draft
aliases: [last_owner]
defined_for: tenant-shop-rbac
rules_hash: e3b0c44298fc
---
# last_owner (409)
## Definition
`last_owner` is the [conflict error](conflict-error.md) returned when a change would leave a [shop](shop-tenant.md) with no [`OWNER`](shop-role.md). It applies to removing, demoting or otherwise changing the last remaining owner. The rule must hold under concurrent changes too, so two simultaneous requests cannot both succeed and leave the shop ownerless. Design intent (not stated in the spec): only an `OWNER` may manage `OWNER` and `ADMIN` roles, so a shop with no owner could not be fully managed again.

## Example
A shop has two owners, Alice and Bob (illustrative names). At the same moment, each demotes the other to `ADMIN`. One change succeeds. The other must answer `409 last_owner`.

## Known gaps
- Not confirmed in the code: how the concurrent case is enforced, for example with a [row lock ↗](../sw-external-terms.md#row-lock), a [guarded update](guarded-update.md) or a constraint.
- The spec does not say whether the last owner can leave by deleting or offboarding the shop instead.

## Used by
<!-- used-by:start -->
- [conflict-error](conflict-error.md)
- [guarded-update](guarded-update.md)
- [plan-limit](plan-limit.md)
- [shop-tenant](shop-tenant.md)
<!-- used-by:end -->
