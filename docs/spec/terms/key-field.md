---
id: key-field
title: Key field
kind: term
status: draft
aliases: [key fields]
defined_for: S04-kyc-onboarding
rules_hash: 642b722c28d7
---
# Key field
## Definition
A key field is a value that must be present in a document's extracted data before the document can be approved. A missing key field is one of the hard checks. During extraction it keeps the document from auto-approval. At moderator approval it refuses the approval. Each document kind (`BUSINESS_REGISTRATION`, `BANK_STATEMENT`, `VAT_CERTIFICATE`) presumably has its own key fields. That per-kind split is design intent (not stated in the spec).

## Example
The model extracts a `BANK_STATEMENT` but returns no account holder (illustrative key field). The document cannot be auto-approved and goes to [`NEEDS_REVIEW`](document-status.md). A moderator who approves it without supplying the field is refused.

## Known gaps
- The spec does not say which fields are key fields for each document kind.
- The spec does not say which error code a missing key field returns at approval; only `iban_invalid` and `vat_invalid` are named.
- The spec does not say whether a moderator can fill in a missing key field when approving.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
