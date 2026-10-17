---
id: upload-mismatch
title: upload_mismatch (422)
kind: term
status: draft
aliases: [upload_mismatch]
defined_for: S04-kyc-onboarding
rules_hash: e3b0c44298fc
---
# upload_mismatch (422)
## Definition
`upload_mismatch` is the error returned when a seller [confirms an upload](document-upload.md) whose stored file does not match what was declared, such as a different size. The uploaded object is deleted, so the seller must upload again. This is different from a [content-type mismatch](content-type-mismatch.md): that is found later by reading the file's bytes, and it [sends the document to review](document-review.md) instead.

## Example
A seller declares a 2 MB PDF (illustrative) but uploads a 3 MB file (illustrative). The confirm returns:
```
HTTP 422
code: upload_mismatch
```
The object is removed from storage.

## Known gaps
- The spec does not say whether a mismatched [SHA-256 ↗](../sw-external-terms.md#sha-256) also produces `upload_mismatch`.
- The spec does not say what status the document has after this error (it may stay [`AWAITING_UPLOAD`](document-status.md)).
- Not confirmed by any acceptance scenario: the behavior that defines this error (S04.B-06) has no proof.

## Used by
<!-- used-by:start -->
- [content-type-mismatch](content-type-mismatch.md)
- [document-review](document-review.md)
- [document-upload](document-upload.md)
<!-- used-by:end -->
