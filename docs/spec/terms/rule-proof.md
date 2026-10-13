---
id: rule-proof
title: Rule and proof
kind: term
status: draft
aliases: [[code], [proof], proofs, rules]
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# Rule and proof
## Definition
A rule is a short, testable statement in the "Rules" section of a [capability page](section.md). Each rule has an id made of the capability and a rule number, such as `S05.R-07`. A `[proof: ...]` tag after the rule lists the [acceptance scenarios](acceptance-scenario.md) that show the rule holds, such as `S05 AS-10`. Tests carry these scenario ids, so you can go from a rule to the tests that check it. Some rules also have a `[code: path#symbol]` tag that points to the code that enforces them.

## Example
```
- **S05.R-07** Update, [archive and restore](product-archive.md) require [`expectedVersion`](expected-version.md); a mismatch gives
  [`409 version_conflict`](version-conflict.md) with [`currentVersion`](version-conflict.md) ... [proof: S05 AS-10, S05 AS-11, S05 AS-20]
```
To check this rule, find the tests that carry `AS-10`, `AS-11` and `AS-20`. Rule `S05.R-09` also has a code link: `[code: packages/backend/libs/domains/catalog/domain/product-status.ts#applyTransition]`.

## [Known gaps](known-gaps.md)
- The spec does not say that every scenario in a `[proof]` tag has a test. The S05 "Known gaps" section lists scenario ids, such as AS-33 and AS-67 to AS-79, that no test carries.
- The spec does not say whether a `[proof]` tag covers every part of a rule. For example, `S05.R-16` and `S05.R-11` have no proof for the case where the limiter or cache store is down.
- The spec does not say how a test carries a scenario id, for example in the test name or in a tag.

## Used by
<!-- used-by:start -->
- [acceptance-scenario](acceptance-scenario.md)
- [behavior](behavior.md)
- [body-html](body-html.md)
- [decisions](decisions.md)
- [known-gaps](known-gaps.md)
- [navbar-unavailable-state](navbar-unavailable-state.md)
- [recorded-decision](recorded-decision.md)
- [reindex-history](reindex-history.md)
- [section](section.md)
- [shop-search-table](shop-search-table.md)
- [tenancy-domain-layer](tenancy-domain-layer.md)
<!-- used-by:end -->
