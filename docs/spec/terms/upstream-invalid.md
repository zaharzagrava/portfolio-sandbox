---
id: upstream-invalid
title: upstream_invalid (502)
kind: term
status: draft
aliases: [upstream_invalid]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# upstream_invalid (502)
## Definition
`upstream_invalid` is the error the product page returns when the product upstream answers with a body that fails `productPublicSchema`. The product is the required section, so the BFF fails the whole page instead of showing a broken product. The response carries a generic `detail` that does not reveal what was wrong with the upstream body. Optional sections never produce it, because they degrade to `null` and add an errors entry.

## Example
`GET /api/bff/product-page/:productId`: the product service answers 200, but the body is missing a field that `productPublicSchema` requires. The client gets `502 upstream_invalid` with a generic `detail` and no partial page.

## Known gaps
- The spec does not say what happens when an optional section's body fails validation. It does not say which errors entry code that would produce.
- The spec does not say whether an invalid product body is retried. The retry rule only covers a 503.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
