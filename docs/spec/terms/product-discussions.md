---
id: product-discussions
title: Discussions (product tab)
kind: term
status: draft
aliases: [?tab=discussions, discussions]
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# Discussions (product tab)
## Definition
Discussions is one of [the tabs on the product page](product-page-tabs.md), next to Details, [Pickup near me](pickup-near-me.md) and Ask about this product. It shows conversation threads about one product. The [`?tab=discussions` query parameter](product-page-tabs.md) opens this panel directly, so a link can point straight at a product's discussions. Any [`bodyHtml`](body-html.md) it shows must pass through the [allow-list sanitiser](html-allow-list-sanitiser.md) before it reaches the [DOM ↗](../sw-external-terms.md#dom).

## Example
`/products/<productId>?tab=discussions` loads the product page with the Discussions panel already open. The short link `/p/<productId>?tab=discussions` lands on the same panel because the redirect keeps the query.

## Known gaps
- The spec does not say what a discussion contains or who can post. The known gaps mention voting, comments and delete, but no rule describes them, and none of the three has a test.
- The spec does not say whether `bodyHtml` belongs to discussion posts. It only states the sanitiser rule, and the sanitiser tests are listed with the Discussions tests.
- Not confirmed in the code: the product page file could not be verified (`packages/web/app/products/[productId` was not found).

## Used by
<!-- used-by:start -->
- [html-allow-list-sanitiser](html-allow-list-sanitiser.md)
- [pickup-near-me](pickup-near-me.md)
- [product-page-tabs](product-page-tabs.md)
- [product-short-link](product-short-link.md)
<!-- used-by:end -->
