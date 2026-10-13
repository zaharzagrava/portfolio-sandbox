---
id: recorded-decision
title: Recorded decision
kind: term
status: draft
aliases: [recorded decisions]
defined_for: S05-products
rules_hash: 5b10a1db6aa0
---
# Recorded decision
## Definition
A recorded decision is a design choice written in the "Decisions" section of a [capability page](section.md), such as the [S05](../capabilities/S05-products.md) page. It explains why the capability is built a certain way. [Rules are testable statements with an id and proofs](rule-proof.md). Decisions are not: they give the reasons behind the rules. Several rules often follow from one decision. Before you change behavior that a decision covers, read the decision first.

## Example
S05 records: "Money is an integer in [minor units](minor-units.md) with one [platform currency](platform-currency.md), never a float." Rule S05.R-03 puts this decision into practice. A currency other than the platform currency is refused with [`422 currency_not_supported`](currency-not-supported.md).
Another S05 decision: "Writes delete cache entries and never write them; an event consumer repairs lost deletes." Rules S05.R-17 and S05.R-18 put it into practice.

## Known gaps
- The spec does not say whether a recorded decision has an id or proofs. The S05 decisions have no id and no `[proof]` or `[code]` tag, so no test can be traced to them directly.
- The spec does not say who may change a recorded decision, or how a change or the reason for it gets recorded.

## Used by
<!-- used-by:start -->
- [minor-units](minor-units.md)
- [platform-currency](platform-currency.md)
- [rule-proof](rule-proof.md)
- [section](section.md)
- [server-rendered-search](server-rendered-search.md)
<!-- used-by:end -->
