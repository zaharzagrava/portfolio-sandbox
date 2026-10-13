---
id: upsert-from-external
title: upsertFromExternal
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# upsertFromExternal
## Definition
`ProductImportService.upsertFromExternal` is an exported command that other domains use to import a product, keyed by [`externalSku`](external-sku.md). If the `externalSku` is new, it creates a product. Sending the same input again is [idempotent ↗](../sw-external-terms.md#idempotency). It never revives an [archived product](product-archive.md).

## Example
`upsertFromExternal` is called with a new `externalSku` and creates the product. A second call with identical input creates nothing new and changes nothing.

## Known gaps
- The spec does not say what a call with the same `externalSku` but different field values does: update the product, ignore the call, or fail. It also does not say whether that update would need [`expectedVersion`](expected-version.md).
- The spec does not say what the call returns or does when the matching product is `ARCHIVED`. It only says the product is not revived.
- Not confirmed in the code: that this command goes through [`ProductCommandService`](product-command-service.md). The decisions say other domains share it, but the facts do not show this command's path.

## Used by
<!-- used-by:start -->
- [product-archive](product-archive.md)
<!-- used-by:end -->
