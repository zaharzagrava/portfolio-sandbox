---
id: best-path
title: Best path
kind: term
status: draft
aliases: []
defined_for: S34-recommendations
rules_hash: a97f332860cc
---
# Best path
## Definition
In the [2-hop lookup](two-hop-lookup.md), one candidate can be reached through more than one [direct neighbour](direct-neighbour.md) ([seed](neighbour-score.md)). Each route gives a different [second-hop score](neighbour-score.md), and the candidate keeps only the highest one. A direct neighbour is never replaced by a second-hop route: it keeps its direct score and [`hops: 1`](hops.md). The requested product itself is never listed, whichever path leads to it.

## Example
Illustrative values (not from the facts), using a [damping factor](damping-factor.md) of 0.5:
- Candidate `X` via seed `A` (0.4) with [entry score](neighbour-score.md) 0.5 gives 0.4 × 0.5 × 0.5 = 0.100.
- Via seed `B` (0.3) with entry score 0.9, it gives 0.3 × 0.9 × 0.5 = 0.135.

`X` is listed once with 0.135 and `hops: 2`.

## Known gaps
- The spec does not say whether the response shows which seed (bridge) produced the winning path.

## Used by
<!-- used-by:start -->
- [S34](../capabilities/S34-recommendations.md): R-10
- [damping-factor](damping-factor.md)
- [direct-neighbour](direct-neighbour.md)
- [neighbour-score](neighbour-score.md)
- [two-hop-lookup](two-hop-lookup.md)
<!-- used-by:end -->
