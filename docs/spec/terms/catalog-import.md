---
id: catalog-import
title: Catalog import
kind: term
status: draft
aliases: [imported, imports]
defined_for: J04-catalog-sync-to-search
rules_hash: 1e308fee17a7
---
# Catalog import
## Definition
A catalog import fills a shop's catalog from a bulk file. The owner starts it with an [`Idempotency-Key`](idempotency-key.md), uploads the file, completes it, and can read it back. It runs [asynchronously from the queue `catalog-imports`](catalog-imports-queue.md) and streams progress and a terminal event over [SSE ↗](../sw-external-terms.md#server-sent-events). Each row reaches the catalog only through its [exported commands](exported-command.md), so the catalog alone writes [`catalog.product_*` events](catalog-product-events.md). Re-importing the same file changes nothing, and a row without a stock column leaves quantity untouched.

## Example
File `F2` updates rows 001–003 to price `18.00` and has no stock column. The import reports `rowsUpdated: 3` and `rowsUnchanged: 57`. Three products move to version 2, quantity stays the same, and search shows the new price. File `F3`, a ZIP renamed `.csv`, ends `FAILED` with `failure.code: unsupported_file_type` and the terminal SSE event `failed`.

## Known gaps
- The spec does not say the full import status model; only `FAILED` is named.
- The spec does not say whether the SSE terminal event can be replayed (FR-016 has no scenario).
- The spec does not say any time limit for an import to finish; the bounds it refers to are undefined.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): R-01, B-02, B-20
- [import-row-counts](import-row-counts.md)
- [unsupported-file-type](unsupported-file-type.md)
<!-- used-by:end -->
