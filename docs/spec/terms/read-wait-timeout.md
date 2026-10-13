---
id: read-wait-timeout
title: Read wait timeout
kind: term
status: draft
aliases: [wait budget]
defined_for: S53-events-projections
rules_hash: 094505283bf1
---
# Read wait timeout
## Definition
The read wait timeout is how long a [read-your-writes](read-your-writes.md) route waits for the [read model's checkpoint](checkpoint-lookup.md) to reach the requested [`minVersion`](min-version.md). In the configuration it is called the read budget, and it has a default and a maximum, which the service checks at startup. If the read model is still behind when the timeout runs out, the route does one of two things, depending on how it is configured: it answers from the [write model](write-model.md), or it answers `202` "pending" to say the data is not ready yet. An invalid `minVersion` is rejected with `400` straight away, without waiting.

## Example
A projection has stopped at version 6, and a client calls the read route with `minVersion=7`. With the default budget of 500 ms, the route waits 500 ms. It then answers `200` with `X-Read-Source: write-model`.

## Known gaps
- The spec does not say how a route chooses a budget other than the default, or whether a caller can request one.
- The spec does not say whether a "pending" route waits for the budget before it answers `202`, or answers at once.

## Used by
<!-- used-by:start -->
- [S53](../capabilities/S53-events-projections.md): B-16
- [checkpoint-lookup](checkpoint-lookup.md)
- [pending-read-mode](pending-read-mode.md)
- [read-your-writes](read-your-writes.md)
- [write-model](write-model.md)
- [x-read-source-header](x-read-source-header.md)
<!-- used-by:end -->
