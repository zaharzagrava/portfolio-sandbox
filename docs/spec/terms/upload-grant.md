---
id: upload-grant
title: Upload grant
kind: term
status: draft
aliases: [grant]
defined_for: S04-kyc-onboarding
rules_hash: 48370078d7bd
---
# Upload grant
## Definition
An upload grant is a short-lived permission the seller receives when requesting a [document upload](document-upload.md). The seller uses it to put the file into storage. The seller then confirms the upload so [extraction](extraction-message.md) can start. The grant expires after a fixed validity period, so a seller who waits too long must request a new one.

## Example
A seller of a [submitted shop](onboarding-application-status.md) requests a [`BANK_STATEMENT`](onboarding-document-type.md) upload. The answer is `201`, the document is `AWAITING_UPLOAD`, and the grant is valid for 15 minutes.

## Known gaps
- The spec does not say what form the grant takes (for example a signed storage URL) or which fields carry it in the response.
- The spec does not say what happens to an `AWAITING_UPLOAD` document whose grant expires without a confirmed upload.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): B-04
- [document-deduplicated-flag](document-deduplicated-flag.md)
- [document-status](document-status.md)
- [submission-required](submission-required.md)
<!-- used-by:end -->
