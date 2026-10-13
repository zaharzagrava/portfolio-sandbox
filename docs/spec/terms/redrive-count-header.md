---
id: redrive-count-header
title: Redrive count header
kind: term
status: draft
aliases: [x-redrive-count, x-redriven-count]
defined_for: S53-events-projections
rules_hash: e3b0c44298fc
---
# Redrive count header
## Definition
The redrive count header is a [Kafka message header ↗](../sw-external-terms.md#kafka-headers) that the [redrive script](dead-letter-redrive.md) sets when it sends a [dead letter](dead-letter-topic.md) back to its [source topic](source-topic). In the code its name is `x-redrive-count`. Its name suggests it counts how many times a message has been [redriven](dead-letter-redrive.md). Using it to spot events that fail again after every redrive is design intent (not stated in the spec).

## Example
```
x-redrive-count: 1   (illustrative value, after the first redrive)
```
This header is set by `pnpm projections:redrive` (see `packages/backend/scripts/projections/redrive.ts`).

## Known gaps
- Not confirmed in the code: which name is correct. Scenario AS-63 uses `x-redriven-count`, but `redrive.ts` uses `x-redrive-count`. The spec marks this mismatch as unresolved, so don't build on either name yet.
- The spec does not say how the value starts or goes up, or whether a limit on the number of redrives is enforced.

## Used by
<!-- used-by:start -->
- [dead-letter-redrive](dead-letter-redrive.md)
- [dead-letter-topic](dead-letter-topic.md)
<!-- used-by:end -->
