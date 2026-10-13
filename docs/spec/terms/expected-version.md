---
id: expected-version
title: expectedVersion
kind: term
status: draft
aliases: []
defined_for: S05-products
rules_hash: e3b0c44298fc
---
# expectedVersion
## Definition
`expectedVersion` is the product [`version`](product-version.md) the client last read. The client sends it back on update, [archive and restore](product-archive.md). The server applies the change only if this value still matches the stored version. If it does not match, the server refuses the change with [`version_conflict`](version-conflict.md). This way, a client cannot overwrite a change it never saw.

## Example
A client reads a product at `version: 3` and sends an update for it (illustrative values):
```
PATCH /shops/:shopId/products/:productId
{ "expectedVersion": 3, "priceMinor": 1299 }
```
If the stored version is still 3, the answer is `200` with `version: 4`. If it is not, the answer is `409 version_conflict`.

## Known gaps
- The spec does not say where archive and restore carry `expectedVersion` (body or query). It also does not say the field name of the price in the body. [`priceMinor`](minor-units.md) above is illustrative.
- The spec does not say which error a request gets when it leaves out `expectedVersion`.

## Used by
<!-- used-by:start -->
- [product-archive](product-archive.md)
<!-- used-by:end -->
