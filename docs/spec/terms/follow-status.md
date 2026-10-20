---
id: follow-status
title: Follow status
kind: term
status: draft
aliases: [following]
defined_for: J05-engagement-loop
rules_hash: fc13a6200c39
---
# Follow status
## Definition
Follow status tells a buyer whether they follow a given shop. It is part of the [follow and feed capability](follow-feed.md) (S26), next to "follow a shop" and "read [the feed](follow-feed.md)". After a successful follow, reading it shows `following: true`. The [engagement journey](main-journeys.md) reads it only to confirm the follow happened before checking the feed.

## Example
Buyer follows shop S, then reads follow status for S:
```json
{ "following": true }
```
(Shape beyond the `following` member is illustrative.)

## [Known gaps](known-gaps.md)
- The spec does not say which route serves follow status, or what other members the answer carries.
- The spec does not say how unfollowing is done or what follow status shows afterwards.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
