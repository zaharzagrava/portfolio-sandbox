---
id: late-result
title: Late result
kind: term
status: draft
aliases: [late results]
defined_for: S04-kyc-onboarding
rules_hash: 43fed765470a
---
# Late result
## Definition
A late result is an outcome for a shop's onboarding that arrives after the application is already [`VERIFIED`](shop-verification.md). Examples are an [extraction](extraction-message.md) that finishes late or a [review decision](document-review.md) on a document. Such a result does not change a `VERIFIED` application. The application stays verified, and no second [`shop.verified` event](shop-verified-event.md) or [purge job](verification-document-purge-job.md) is created. Design intent (not stated in the spec): verification is announced once, and slow background work must not reopen or undo it.

## Example
A shop's `BUSINESS_REGISTRATION` and `BANK_STATEMENT` are approved, so the application becomes `VERIFIED` and `shop.verified` is emitted. A queue redelivery of `onboarding.extract_document` for an older document then completes. The application stays `VERIFIED` and nothing is published.

## Known gaps
- The spec does not say which result kinds count as "late". It does not say whether a late document result still updates that document's own status.
- The spec does not say whether a late result is logged or counted anywhere.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): R-27
- [rejected-operation](rejected-operation.md)
<!-- used-by:end -->
