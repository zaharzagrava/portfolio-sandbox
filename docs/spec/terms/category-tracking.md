---
id: category-tracking
title: Category tracking
kind: term
status: draft
aliases: [categories, category]
defined_for: S35-trending
rules_hash: 85ce1074e456
---
# Category tracking
## Definition
Inside each [partition window](trending-window.md), the [consumer](event-consumer.md) keeps separate counts for each product category, so [the endpoint](get-trending.md) can answer per-category rankings. A setting in the configuration limits how many categories are tracked per window, which keeps memory use fixed. Events from categories past that limit still count toward the overall ranking that covers every category, but not toward any per-category ranking.

## Example
One partition window sees events from 1,000 categories. The consumer tracks 100 of them with their own counts. The other 900 add to `all` only, so a request for one of those 900 categories may return fewer items than expected for that window.

## Known gaps
- The spec does not say which categories get tracked once the cap is reached. It could be the first ones seen or the heaviest ones.
- The spec does not say whether the category used for tracking comes from the event or from the catalog. Rule S35.R-09 only says [the catalog decides the category](catalog-category.md) at [serve time](serve-time.md).
- The spec does not say whether hitting the cap is recorded in a metric.

## Used by
<!-- used-by:start -->
- [S35](../capabilities/S35-trending.md): B-18
- [all-bucket](all-bucket.md)
- [catalog-category](catalog-category.md)
- [event-consumer](event-consumer.md)
- [get-trending](get-trending.md)
- [serve-time](serve-time.md)
- [trending-window](trending-window.md)
<!-- used-by:end -->
