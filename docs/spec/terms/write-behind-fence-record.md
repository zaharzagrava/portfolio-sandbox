---
id: write-behind-fence-record
title: Fence record (write-behind)
kind: term
status: draft
aliases: [fence, fence record, fence records]
defined_for: S52-cache-toolkit
rules_hash: e3b0c44298fc
---
# Fence record (write-behind)
## Definition
A fence record is helper state in the [shared store](l2-cache.md), listed next to the counter record and the [in-flight batch](write-behind-in-flight-batch.md) record. The spec groups all three records under two classes together, the class that keeps the write-behind count and [`DistributedLock` ↗](../sw-external-terms.md#distributed-lock), so it is not clear which class owns which record. `DistributedLock` exposes `isNewerFence`, which suggests a fence record stores the newest fence value seen for a key. Design intent (not stated in the spec): it lets the system reject a slow holder whose claim or lock has already passed to someone else.

## Example
Illustrative only:
- Worker A claims a batch with fence 7, stalls, and its claim expires.
- Worker B reclaims the batch with fence 8. A's late write carries 7, `isNewerFence` says it is not newer, and the write is refused.

## Known gaps
- The spec does not say what a fence record stores or how it is keyed.
- The spec does not say whether `WriteBehindCounter`, `DistributedLock` or both write fence records.
- Not confirmed in the code: that `isNewerFence` compares against a fence record, or that `commit` checks a fence.

## Used by
<!-- used-by:start -->
- [l2-cache](l2-cache.md)
- [write-behind-counter](write-behind-counter.md)
- [write-behind-in-flight-batch](write-behind-in-flight-batch.md)
- [write-behind-reclaim-expired](write-behind-reclaim-expired.md)
<!-- used-by:end -->
