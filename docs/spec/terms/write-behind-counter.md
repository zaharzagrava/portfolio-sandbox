---
id: write-behind-counter
title: WriteBehindCounter
kind: term
status: draft
aliases: [write-behind counters]
defined_for: S52-cache-toolkit
rules_hash: 0a611e78fec3
---
# WriteBehindCounter
## Definition
`WriteBehindCounter` is [the toolkit's counter](platform-toolkit.md) for frequent increments, such as counting events. It keeps counts in the [shared store](l2-cache.md) first and writes them to their final home in batches later. It stores counter, [in-flight batch](write-behind-in-flight-batch.md) and [fence records](write-behind-fence-record.md) in the shared store. Its operations are `increment`, `drain`, `restore`, `[claim](write-behind-claim.md)`, `commit`, `release` and `[reclaimExpired](write-behind-reclaim-expired.md)`. Design intent (not stated in the spec): it keeps very frequent small writes off the database by combining them before they are written.

## Example
Illustrative flow, read from the method names only. The spec does not describe these methods.
- Each event calls `increment` on a counter key.
- A flush worker `claim`s a batch, writes it to the database, then calls `commit`. If the write fails, it calls `release` instead.
- `reclaimExpired` takes back batches whose claim timed out.

## Known gaps
- The spec does not describe the contract of any method: arguments, return values, claim lifetime, or what `drain` and `restore` do.
- The spec does not say whether a failed flush can count an increment twice, or what fence records guard against.
- The spec does not say how `increment` fits S52.R-20, the rule that the toolkit exposes no method that stores a caller-supplied value.

## Used by
<!-- used-by:start -->
- [S05](../capabilities/S05-products.md): R-21, R-22
- [l2-cache](l2-cache.md)
- [platform-toolkit](platform-toolkit.md)
- [write-behind-fence-record](write-behind-fence-record.md)
- [write-behind-in-flight-batch](write-behind-in-flight-batch.md)
<!-- used-by:end -->
