---
id: journal-conflict
title: JournalConflict
kind: term
status: draft
aliases: []
defined_for: S14-ledger-reconciliation
rules_hash: e3b0c44298fc
---
# JournalConflict
## Definition
`JournalConflict` is the error raised when a posting reuses an existing [(kind, reference)](journal-kind-reference.md) but its content is different. An identical second posting is not an error: it returns the existing journal with [`created: false`](enqueue-created-flag.md). Raising an error for the different-content case keeps one business reference from silently standing for two different money movements. That reason is design intent (not stated in the spec).

## Example
A caller posts [`AD_CHARGE`](journal-kind.md) for reference `inv-123` with 500 [minor units](minor-units.md), then posts it again with 700. The second call raises `JournalConflict` and writes nothing. (Values are illustrative.)

## Known gaps
- The spec does not say which fields are compared to decide "identical" (lines, currency, payer reference, [`postedAt`](posted-at.md)).
- The spec does not say whether `JournalConflict` is mapped to an HTTP status when it reaches an API caller.

## Used by
<!-- used-by:start -->
- [journal-kind-reference](journal-kind-reference.md)
- [minor-units](minor-units.md)
<!-- used-by:end -->
