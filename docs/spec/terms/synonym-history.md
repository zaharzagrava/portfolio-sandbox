---
id: synonym-history
title: Synonym history
kind: term
status: draft
aliases: [history]
defined_for: S32-product-search
rules_hash: 5f738415dce5
---
# Synonym history
## Definition
The synonym history is the stored record of past [synonym rules versions](synonym-rules-version.md). It keeps only a limited number of recent versions for a limited time. The current version is never dropped, even when it is older than the [retention period](bounded-retention.md). Each successful edit also writes an [audit line](audit-log.md) that records who changed the rules, the new version and the [rule count](synonym-rule-count.md).

## Example
An admin made their last synonym edit four months ago. Older versions have expired from the history, but that last version stays because it is still the current one. (The scenario is illustrative.)

## Known gaps
- The spec does not say whether there is an endpoint to read the history or to roll back to an older version.
- The spec does not say whether a history entry holds the full rules or only the audit line (`actorId`, `version`, `ruleCount`).
- The spec does not say how the history relates to the audit log.

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-32
- [audit-log](audit-log.md)
- [bounded-retention](bounded-retention.md)
- [synonym-rule-count](synonym-rule-count.md)
- [synonym-rules-version](synonym-rules-version.md)
- [synonym-rules](synonym-rules.md)
- [synonyms-unchanged-flag](synonyms-unchanged-flag.md)
<!-- used-by:end -->
