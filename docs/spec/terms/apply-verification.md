---
id: apply-verification
title: applyVerification
kind: term
status: draft
aliases: []
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# applyVerification
## Definition
`applyVerification` is the domain function that moves a shop from one [shop verification state](shop-verification.md) to the next. It accepts only the allowed moves and treats [`VERIFIED`](shop-verification.md) as final. It also keeps [`payoutsEnabled`](payouts-enabled.md) in step with the result, so the flag is true only when the shop is `VERIFIED`. It lives in the [tenancy domain layer](tenancy-domain-layer.md), next to `nextState`, which does the same job for [shop status](shop-status.md).

## Example
In `packages/backend/libs/domains/tenancy/domain/verification-status.ts`:
- A shop in `PENDING` that is approved becomes `VERIFIED`, and `payoutsEnabled` becomes true.
- A shop in `REJECTED` can go back to `PENDING`.
- An attempt to move a `VERIFIED` shop to `PENDING` is refused.

## Known gaps
- The spec does not say which error a refused move returns. For shop status the error is `invalid_transition`, but the spec gives no equivalent for verification.
- Not confirmed in the code: whether `applyVerification` itself appends the `tenancy.shop_verification_changed` event, or whether its caller does.
- The spec does not say who calls it (a seller action, an admin, or an external provider).

## Used by
<!-- used-by:start -->
- [shop-status](shop-status.md)
- [shop-verification](shop-verification.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
