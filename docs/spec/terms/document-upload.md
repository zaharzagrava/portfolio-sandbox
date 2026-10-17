---
id: document-upload
title: Document upload
kind: term
status: draft
aliases: [confirmed, upload]
defined_for: S04-kyc-onboarding
rules_hash: 8434b3876ff6
---
# Document upload
## Definition
A document upload is the seller-side flow that delivers one [KYC ↗](../sw-external-terms.md#kyc) file. It has three steps: request an upload grant, put the file in storage, then confirm. A request needs a [submitted application](onboarding-application-status.md). It is refused when that kind is already approved, when the application is verified, or when the application was rejected. On confirm, the document moves to `QUEUED`, and [the extraction message](extraction-message.md) is appended to the [outbox](inbox-table.md) in the same transaction. Confirming a new file [supersedes](document-supersede.md) older unresolved or rejected documents of the same kind.

## Example
A seller requests a `BANK_STATEMENT` upload and gets `201` with status `AWAITING_UPLOAD`. They upload a PDF and confirm. The document becomes `QUEUED`, and `onboarding.extract_document {documentId}` is relayed to the [`onboarding-documents` queue](onboarding-documents-queue.md). Repeating the request with the same [SHA-256 ↗](../sw-external-terms.md#sha-256) answers `200` with `deduplicated: true` and the same ID.

## Known gaps
- The spec does not say whether the seller confirms through a separate route or how a confirm for an unknown document ID is answered.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): B-04, B-06
- [already-verified](already-verified.md)
- [document-already-approved](document-already-approved.md)
- [document-content-hash](document-content-hash.md)
- [document-deduplicated-flag](document-deduplicated-flag.md)
- [document-not-required](document-not-required.md)
- [document-supersede](document-supersede.md)
- [extraction-message](extraction-message.md)
- [inbox-table](inbox-table.md)
- [onboarding-application-status](onboarding-application-status.md)
- [onboarding-documents-queue](onboarding-documents-queue.md)
- [resubmission-required](resubmission-required.md)
- [submission-required](submission-required.md)
- [upload-grant](upload-grant.md)
- [upload-mismatch](upload-mismatch.md)
<!-- used-by:end -->
