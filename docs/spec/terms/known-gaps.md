---
id: known-gaps
title: Known gaps
kind: term
status: draft
aliases: [known gaps section]
defined_for: S05-products
rules_hash: 17d132071ad4
---
# Known gaps
## Definition
Known gaps is the last section of a [capability page](capability.md). It lists what the page claims but cannot yet prove. Examples are [acceptance scenarios](acceptance-scenario.md) that no test carries, and rules with no [`[proof]`](rule-proof.md) for some case, such as an outage. Read it before you rely on a rule. A rule that appears here may be implemented, but no test has confirmed it.

## Example
[S05](../capabilities/S05-products.md)'s Known gaps says: "[AS-81](acceptance-scenario.md) ([sandbox stamping](sandbox-product.md)) has no test carrying its id." It also says `S05.R-11` has no proof for the rate-limit [fail-closed ↗](../sw-external-terms.md#fail-open-fail-closed) behavior when [the limiter](rate-limit-policy.md) is down. If your code depends on writes being refused during a limiter outage, nothing has checked that yet.

## Known gaps
- The spec does not say whether the list is complete. A gap that nobody noticed will not appear here.
- The spec does not say who owns each gap or whether there is a plan to close it.
- The spec does not say what some entries mean. For example, the S05 entry "AS-36 [hot key](hot-key.md) as listed in the code excerpts beyond cache tests" is unclear about what is and is not covered.

## Used by
<!-- used-by:start -->
- [acceptance-scenario](acceptance-scenario.md)
- [body-html](body-html.md)
- [capability](capability.md)
- [code-facts](code-facts.md)
- [failure-counter](failure-counter.md)
- [hot-key](hot-key.md)
- [rate-limit-policy](rate-limit-policy.md)
- [rule-proof](rule-proof.md)
- [sandbox-product](sandbox-product.md)
- [search-sort-order](search-sort-order.md)
- [source-code-url](source-code-url.md)
<!-- used-by:end -->
