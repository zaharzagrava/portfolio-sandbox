---
id: catalog-import-file
title: Catalog import file
kind: term
status: draft
aliases: [catalog file]
defined_for: J04-catalog-sync-to-search
rules_hash: 6f7567a0d969
---
# Catalog import file
## Definition
A catalog import file is a bulk file a seller uploads to fill or update a shop's catalog. Each row describes one product.

- A row without a [stock column](catalog-stock.md) leaves the product's quantity untouched.
- A file whose [real type](real-file-type.md) is not accepted ends the import [`FAILED`](import-run-status.md) with [`failure.code: unsupported_file_type`](unsupported-file-type.md) and changes no product.
- Importing the same file again changes nothing and [emits no event](outbox-append.md).

## Example
`F1` has 60 rows and creates products that appear in search (J04.B-01).

`F2` sets rows 001–003 to price `18.00`, with no stock column (J04.B-03).

`F3` is a ZIP renamed `.csv`, so the import ends `FAILED` (J04.B-04).

## Known gaps
- The spec does not list the accepted file types beyond CSV, the required columns, or a size or row limit.
- The spec does not say how a row is matched to an existing product.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
