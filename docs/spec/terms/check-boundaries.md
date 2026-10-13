---
id: check-boundaries
title: check:boundaries
kind: term
status: draft
aliases: []
defined_for: S32-product-search
rules_hash: e3b0c44298fc
---
# check:boundaries
## Definition
`check:boundaries` is a repository check that reports violations of the [domain boundary rules](domain-boundary-rules.md). An example is one domain importing [another domain's internals](domain-boundary-rules.md) or [a foreign model](domain-boundary-rules.md). For search, the check must report nothing. It is run together with [`check:table-ownership`](table-ownership.md), which covers SQL on tables the domain does not own.

## Example
Suppose someone adds an import of a catalog model into the search code. `check:boundaries` then reports a [finding](boundary-finding.md), and S32.R-47 is broken until the import is removed.

## Known gaps
- The spec does not say how the check is run (which command or script) or whether it blocks CI.
- The spec does not list every kind of violation it detects beyond foreign imports and [barrel contents](barrel-export.md).

## Used by
<!-- used-by:start -->
- [barrel-export](barrel-export.md)
- [boundary-finding](boundary-finding.md)
- [domain-boundary-rules](domain-boundary-rules.md)
<!-- used-by:end -->
