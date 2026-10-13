---
id: write-behind-claim
title: claim (write-behind batch)
kind: term
status: draft
aliases: [claim, claim lifetime, claims]
defined_for: S52-cache-toolkit
rules_hash: 1cc8038fc3c8
---
# claim (write-behind batch)
## Definition
`claim` is a method of [`WriteBehindCounter`](write-behind-counter.md). Going by its name, a [flush worker](shutdown-flush.md) uses it to take ownership of pending counts as an [in-flight batch](write-behind-in-flight-batch.md), so no other worker writes the same counts. The worker should then end the claim with `commit` after a successful write, or [`release`](concurrency-lease-release.md) after a failed one. A claim that is never ended looks like it is recovered by [`reclaimExpired`](write-behind-reclaim-expired.md). That reading is design intent (not stated in the spec).

## Example
Illustrative only:
```text
batch = claim(...)        // worker now owns these counts
write batch to database
commit(batch)             // on failure: release(batch)
```

## Known gaps
- The spec does not give the signature of `claim`, what it returns, or how long a claim lasts.
- The spec does not say how `claim` differs from `drain`, or what `restore` does.
- The spec does not say whether two workers calling `claim` at the same time are guaranteed to get separate batches.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-21
- [never-send-twice-guard](never-send-twice-guard.md)
- [shutdown-flush](shutdown-flush.md)
- [write-behind-in-flight-batch](write-behind-in-flight-batch.md)
- [write-behind-reclaim-expired](write-behind-reclaim-expired.md)
<!-- used-by:end -->
