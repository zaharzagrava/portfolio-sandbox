---
id: import-row-counts
title: Import row counts
kind: term
status: draft
aliases: [rowsunchanged, rowsupdated]
defined_for: J04-catalog-sync-to-search
rules_hash: e3b0c44298fc
---
# Import row counts
## Definition
Import row counts are the totals a finished [bulk import](catalog-import.md) reports about its rows. `rowsUpdated` counts rows that changed a product. `rowsUnchanged` counts rows that matched the stored product and changed nothing. An unchanged row emits no event and does not raise [`productVersion`](product-version.md). This lets a caller check what an import actually did without reading every product.

## Example
`F2` has 60 rows, and only rows 001–003 have a new price (J04.B-03):
```json
{ "rowsUpdated": 3, "rowsUnchanged": 57 }
```

## Known gaps
- The spec does not name the other counters, such as created or rejected rows, or the full result shape.
- The spec does not say whether the counts appear in the [SSE terminal event ↗](../sw-external-terms.md#server-sent-events), in the [import read](catalog-import.md), or in both.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
