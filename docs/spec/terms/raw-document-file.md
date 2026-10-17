---
id: raw-document-file
title: Raw document file
kind: term
status: draft
aliases: [raw files]
defined_for: S04-kyc-onboarding
rules_hash: 4d00ae778f5f
---
# Raw document file
## Definition
The original bytes a seller uploads for a [KYC ↗](../sw-external-terms.md#kyc) document, such as a company registration or bank statement. The seller uploads it with an upload grant and then confirms the upload. The [extraction worker](extraction-worker.md) reads the [real file type](real-file-type.md) from these bytes and sends the content to the model. Raw files are temporary: the purge job deletes them, and they are deleted at once when the shop is deleted. Only masked and sealed extracted values remain.

## Example
A seller uploads a `BANK_STATEMENT` as a PDF and confirms it. Extraction reads the IBAN from the file. After `tenancy.shop_deleted` is consumed, that PDF is deleted immediately, without waiting for the purge job.

## Known gaps
- The spec does not name the storage bucket or object key layout for raw files.
- The spec does not say whether raw files of `SUPERSEDED` documents are deleted earlier than the round's purge.

## Used by
<!-- used-by:start -->
- [S04](../capabilities/S04-kyc-onboarding.md): B-19, B-20
- [document-round](document-round.md)
- [kyc-record-retention-days](kyc-record-retention-days.md)
- [masked-value](masked-value.md)
- [onboarding-document-purge-job](onboarding-document-purge-job.md)
- [sealed-copy](sealed-copy.md)
- [sealed-row](sealed-row.md)
<!-- used-by:end -->
