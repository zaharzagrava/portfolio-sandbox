---
id: write-behind-reclaim-expired
title: reclaimExpired
kind: term
status: draft
aliases: []
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# reclaimExpired
## Definition
`reclaimExpired` is a method of [`WriteBehindCounter`](write-behind-counter.md). Going by its name, it takes back [in-flight batches](write-behind-in-flight-batch.md) whose [claim has expired](write-behind-claim.md). Those counts can then be [flushed](shutdown-flush.md) again instead of being lost. Design intent (not stated in the spec): this protects counts when a flush worker crashes or stalls after `claim` and never calls `commit` or `release`.

## Example
Illustrative only:
- A worker calls `claim`, then crashes before `commit`.
- Later, a periodic call to `reclaimExpired` finds the expired batch and makes its counts available to the next `claim`.

## Known gaps
- The spec does not say when a claim counts as expired, or who calls `reclaimExpired` and how often.
- The spec does not say whether reclaimed counts go back into the counter or stay as a batch that can be claimed again.
- The spec does not say what stops the original worker from committing after its batch was reclaimed. [Fence records](write-behind-fence-record.md) might do this, but that is not confirmed.

## Used by
<!-- used-by:start -->
- [shutdown-flush](shutdown-flush.md)
- [write-behind-claim](write-behind-claim.md)
- [write-behind-fence-record](write-behind-fence-record.md)
- [write-behind-in-flight-batch](write-behind-in-flight-batch.md)
<!-- used-by:end -->
