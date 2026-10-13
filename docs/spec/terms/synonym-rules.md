---
id: synonym-rules
title: Synonym rules
kind: term
status: draft
aliases: [one-way rules, rules, two-way rules]
defined_for: S32-product-search
rules_hash: b6cbb162c5c1
---
# Synonym rules
## Definition
Synonym rules tell the search engine which words should be treated as matches for each other in product search. A two-way rule (`a, b`) makes the terms match each other. A one-way rule (`a => b`) works in one direction only, from the left side to the right side. A term can be several words long. [The rules are versioned](synonym-rules-version.md), apply to every document [without a reindex](zero-downtime-reindexing.md), survive a reindex, and keep a [bounded version history](synonym-history.md).

## Example
```
sofa, couch                 (two-way: either word finds both)
tv => television            (one-way)
cell phone, mobile phone    (multi-word terms)
```
These rules are illustrative. You read them with `GET /admin/search/synonyms` and replace them with `PUT /admin/search/synonyms`.

## Known gaps
- The spec does not spell out exactly how a one-way rule matches, for example whether a search for the left term still matches the left term itself.
- The spec does not list which characters are "disallowed".

## Used by
<!-- used-by:start -->
- [S32](../capabilities/S32-product-search.md): R-27
- [invalid-synonym-rules](invalid-synonym-rules.md)
- [put-admin-search-synonyms](put-admin-search-synonyms.md)
- [synonym-cycle](synonym-cycle.md)
- [synonym-history](synonym-history.md)
- [synonym-rules-version](synonym-rules-version.md)
- [synonyms-unchanged-flag](synonyms-unchanged-flag.md)
- [zero-downtime-reindexing](zero-downtime-reindexing.md)
<!-- used-by:end -->
