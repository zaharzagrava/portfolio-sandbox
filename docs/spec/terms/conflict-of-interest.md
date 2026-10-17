---
id: conflict-of-interest
title: conflict_of_interest (403)
kind: term
status: draft
aliases: [conflict_of_interest]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# conflict_of_interest (403)
## Definition
`conflict_of_interest` is the 403 error code the [review endpoints](document-review.md) return when the reviewer is a [shop member](shop-member.md) of the shop under review. The caller already has a [platform role](platform-admin.md) allowed to review (`ADMIN` or [`MODERATOR`](moderator.md)), but may not judge their own shop's [KYC documents ↗](../sw-external-terms.md#kyc). It is separate from [`insufficient_role`](insufficient-role.md), which is for callers without a reviewing role at all. Design intent (not stated in the spec): a person behind a shop must not approve that shop's own verification.

## Example
A user with platform role `MODERATOR` is also staff of shop "Acme Ceramics" (illustrative name). They try to approve the `BANK_STATEMENT` [review task](review-task.md) for that shop. The answer is `403 conflict_of_interest`, and the task stays open.

## Known gaps
- The spec does not say whether listing open review tasks hides or refuses the tasks of the reviewer's own shops, or whether the refusal applies only when resolving a task.
- The spec does not say whether an `ADMIN` is also blocked, or whether there is any override.

## Used by
<!-- used-by:start -->
- [document-review](document-review.md)
- [platform-admin](platform-admin.md)
- [review-task](review-task.md)
- [shop-member](shop-member.md)
<!-- used-by:end -->
