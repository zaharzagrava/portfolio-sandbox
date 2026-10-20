---
id: anonymous-exposure
title: Anonymous exposure
kind: term
status: draft
aliases: []
defined_for: J05-engagement-loop
rules_hash: 8615a59c511a
---
# Anonymous exposure
## Definition
An anonymous exposure is an [experiment exposure](experiment-exposure.md) recorded for a visitor who is not signed in. It [does not join the experiment](experiment-exposure.md), so it cannot later be paired with a signed-in purchase. Design intent (not stated in the spec): a [signed-in conversion](conversion.md) can only be matched reliably to an exposure from the same signed-in buyer.

## Example
Friend F sees a variant while browsing anonymously, then signs in and buys. The anonymous exposure does not join, so the purchase is not counted as a conversion from that exposure.

## Known gaps
- The spec does not say whether anonymous exposures appear in the [per-variant exposure counts](experiment-variant.md). The scenario stating this ([AS-33](acceptance-scenario.md), second half) is [truncated in the facts](code-facts.md).
- The spec does not say whether an anonymous exposure is linked to the account when the visitor later signs in.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
