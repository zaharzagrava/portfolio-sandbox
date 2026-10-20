---
id: rejected-members
title: rejected (response member)
kind: term
status: draft
aliases: [rejected]
defined_for: J05-engagement-loop
rules_hash: e3b0c44298fc
---
# rejected (response member)
## Definition
`rejected` is a member of the answer to an [event submission](search-performed-event.md), and it lists the submitted events that were invalid. Every event it lists left [trending scores](trending-score.md) unchanged (J05.R-17). It lets the sender see which events were refused, instead of losing them silently. That purpose is design intent (not stated in the spec).

## Example
Illustrative. The spec does not define the element shape:
```json
{ "rejected": [ { "index": 2 } ] }
```

## Known gaps
- The spec does not say what each entry in `rejected` contains, such as an index, an [event id](event-id.md), or a reason.
- The spec does not say which endpoint returns it, or with which HTTP status.
- The spec does not say whether duplicate event ids appear in `rejected` or are dropped silently.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
