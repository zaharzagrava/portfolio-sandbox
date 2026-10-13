---
id: synonym-rule-count
title: ruleCount
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: 686ed83dafcd
---
# ruleCount
## Definition
`ruleCount` is a field of the [audit line](audit-log.md) that every successful synonym edit writes, next to [`actorId`](actor-id.md) and `[version](synonym-rules-version.md)`. It records how many rules the new version contains. It lets an operator see how big each edit was without storing or reading the full rules.

## Example
```json
{ "actorId": "<adminId>", "version": 8, "ruleCount": 2 }
```
(The values are illustrative. Here `rules` was `["sofa, couch", "tv => television"]`.)

## Known gaps
- The spec does not say how a rule is counted. For example, it does not say whether a two-way rule with several terms counts as one rule.

## Used by
<!-- used-by:start -->
- [audit-log](audit-log.md)
- [synonym-history](synonym-history.md)
<!-- used-by:end -->
