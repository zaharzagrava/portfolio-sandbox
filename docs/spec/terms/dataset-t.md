---
id: dataset-t
title: Dataset T
kind: term
status: draft
aliases: [dataset t merged]
defined_for: S35-trending
rules_hash: af6de192e77c
---
# Dataset T
## Definition
Dataset T is a fixed set of test events used by the [trending acceptance scenarios](acceptance-scenario.md). Scenarios start from "dataset T merged", meaning its [windows](trending-window.md) have already been merged into the [aggregate](trending-aggregate.md). Each scenario then calls [the trending endpoint](get-trending.md) and checks the [ranking](trending-ranking-cache.md) it gets back. It is test material only, not something that exists in production.

## Example
S35.B-01: with dataset T merged, an anonymous `GET /api/trending?category=audio` answers `200` with `windowMinutes: 60` and ranked items with their score. S35.B-02: with the same dataset, omitting `category` and sending `category=all` give identical answers.

## Known gaps
- The spec does not say what dataset T contains: which products, categories, event counts or timestamps.
- The spec does not say where dataset T is defined in the code or test fixtures.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-01
- [acceptance-scenario](acceptance-scenario.md)
- [get-trending](get-trending.md)
- [trending-aggregate](trending-aggregate.md)
- [trending-ranking-cache](trending-ranking-cache.md)
- [trending-window](trending-window.md)
- [window-minutes](window-minutes.md)
<!-- used-by:end -->
