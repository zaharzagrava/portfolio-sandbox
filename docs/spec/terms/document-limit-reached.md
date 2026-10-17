---
id: document-limit-reached
title: document_limit_reached (409)
kind: term
status: draft
aliases: [document_limit_reached]
defined_for: S04-kyc-onboarding
rules_hash: e673a0d042fd
---
# document_limit_reached (409)
## Definition
`document_limit_reached` is the [`409`](conflict-error.md) error returned when a seller requests another document of a kind that already has the maximum number of distinct documents in the current round. It stops a seller from uploading files for one kind without end. A repeated request for the same content is deduplicated, not counted, so it never triggers this error.

## Example
A seller has already requested five different [`BANK_STATEMENT`](onboarding-document-type.md) files in round 1. A request with a sixth, new content hash answers `409 document_limit_reached`.

## Known gaps
- The spec does not say whether [`SUPERSEDED`](document-supersede.md) or [`REJECTED`](document-status.md) documents count toward the limit. This decides whether a seller who keeps replacing a file can get stuck.

## Used by
<!-- used-by:start -->
- [document-round](document-round.md)
- [onboarding-document-type](onboarding-document-type.md)
<!-- used-by:end -->
