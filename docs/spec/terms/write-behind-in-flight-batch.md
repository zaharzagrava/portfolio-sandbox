---
id: write-behind-in-flight-batch
title: In-flight batch (write-behind)
kind: term
status: draft
aliases: [batch, in-flight batch]
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# In-flight batch (write-behind)
## Definition
An in-flight batch is one of the record types that [`WriteBehindCounter`](write-behind-counter.md) keeps in the shared store. The others are counter records and records that keep older writes from overwriting newer ones. The name and the usual [write-behind pattern ↗](../sw-external-terms.md#write-behind-counters) suggest it holds counts taken from a counter that are on their way to their final home but not yet confirmed. That reading is design intent (not stated in the spec). The toolkit owns these records, and they are helper state, not business data.

## Example
Illustrative only, based on the method names:
- A flush worker calls [`claim`](write-behind-claim.md), and the pending counts become an in-flight batch.
- The worker writes the batch, then calls `commit`. If the write fails, it calls `release`.
- If the worker dies, [`reclaimExpired`](write-behind-reclaim-expired.md) takes the batch back so the counts are not lost.

## Known gaps
- The spec does not say what an in-flight batch contains, how it is keyed or how long it lives.
- The spec does not say which methods create or remove it. The links to `claim`, `commit`, `release` and `reclaimExpired` come only from the method names.
- The spec does not say whether a batch that is reclaimed and then committed late can be counted twice.

## Used by
<!-- used-by:start -->
- [write-behind-claim](write-behind-claim.md)
- [write-behind-counter](write-behind-counter.md)
- [write-behind-fence-record](write-behind-fence-record.md)
- [write-behind-reclaim-expired](write-behind-reclaim-expired.md)
<!-- used-by:end -->
