---
id: shop-onboarding-document-rejected-event
title: shop.onboarding_document_rejected event
kind: term
status: draft
aliases: [shop.onboarding_document_rejected]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# shop.onboarding_document_rejected event
## Definition
An event that the [KYC ↗](../sw-external-terms.md#kyc) onboarding capability appends when a [moderator](moderator.md) rejects one uploaded document. It records that one [document kind](document-kind.md) needs a new file from the seller. The whole application is not rejected; that case uses the [`shop.rejected` event](shop-rejected-event.md) instead. If the rejection itself is refused, for example by a [losing resolver](task-already-resolved.md), no event is appended.

## Example
A moderator resolves the [open review task](review-task.md) for a shop's `BANK_STATEMENT` with "reject document" and the reason "Statement is older than allowed" (illustrative). The document becomes [`REJECTED`](document-status.md), the seller sees the reason, and `shop.onboarding_document_rejected` is appended.

## Known gaps
- The spec does not say what the event payload contains, for example the document ID, the kind or the reason.
- The spec does not say which capabilities consume this event, for example whether it triggers a notification to the seller.
- The spec does not say whether the event is appended in the [same transaction ↗](../sw-external-terms.md#database-transaction) as the document status change. It states this only for [`shop.verified`](shop-verified-event.md).

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
