---
id: destination-not-allowed
title: destination_not_allowed (422)
kind: term
status: draft
aliases: [destination_not_allowed]
defined_for: J05-engagement-loop
rules_hash: 695792e54c18
---
# destination_not_allowed (422)
## Definition
`destination_not_allowed` is the error code returned with `422` when someone creates a [share link](referral-link.md) whose destination lies [outside the marketplace](referral-link-destination.md). The request creates nothing: no link exists afterwards.

## Example
B tries to create a share link pointing to an external site (`https://example.com`, illustrative). The answer is `422` with code `destination_not_allowed`, and B's links are unchanged (J05 B-18).

## [Known gaps](known-gaps.md)
- The spec does not say which route creates a share link.
- The spec does not say how the system decides that a destination is "outside the marketplace", for example by host or path.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
