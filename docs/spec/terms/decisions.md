---
id: decisions
title: Decisions
kind: term
status: draft
aliases: []
defined_for: S52-cache-toolkit
rules_hash: f47d2afb5d65
---
# Decisions
## Definition
Decisions is a section of a [capability page](capability.md). It lists the design choices behind the capability, and each choice comes with its reason. The rules say what the system must do, and the Decisions say why it was built that way. Decision bullets have no [proof or code tags](rule-proof.md); rules have them. When another page says "the Decisions give its purpose", the reason comes from this section.

## Example
The S52 page has this decision: "When the store is down, reads answer from the [single-flighted loader ↗](../sw-external-terms.md#single-flight), with a [circuit breaker ↗](../sw-external-terms.md#circuit-breaker) and a [loader bulkhead ↗](../sw-external-terms.md#bulkhead) to protect the database." The cache store circuit breaker page takes its stated purpose from this line.

## Known gaps
- The spec does not say whether a decision is binding like a rule or only explains a rule. Decisions have no proof tags, so no acceptance scenario checks them directly.
- The spec does not say what the full list of S52 decisions is. The section in the source page stops mid-sentence ("Time and").

## Used by
<!-- used-by:start -->
- [cache-store-circuit-breaker](cache-store-circuit-breaker.md)
- [capability](capability.md)
- [loader-concurrency-limit](loader-concurrency-limit.md)
- [rule-proof](rule-proof.md)
<!-- used-by:end -->
