---
id: external-sku
title: externalSku
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# externalSku
## Definition
`externalSku` is the identifier of a product in an outside system that feeds products into the catalog. `upsertFromExternal` uses it as the matching key. An unseen `externalSku` creates a new product, and a known one matches the existing product.

## Example
An import sends a product with `externalSku: "ACME-4411"` (illustrative). No product carries that SKU yet, so `upsertFromExternal` creates one.

## Known gaps
- The spec does not say whether `externalSku` is unique per shop or across the whole platform.
- The spec does not say which table or column stores it, or whether the member or public product views show it.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
