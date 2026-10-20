---
id: conditional-absolute-write
title: Conditional absolute write
kind: term
status: draft
aliases: []
defined_for: J04-catalog-sync-to-search
rules_hash: f60dd5538e9a
---
# Conditional absolute write
## Definition
A write to Shopify that sets a [variant's](shopify-variant.md) inventory to an exact quantity, but only if Shopify still holds the quantity the marketplace expects. If Shopify's current value differs, Shopify refuses the write and the [stock three-way merge](stock-three-way-merge.md) runs. Only Shopify-linked products get this write; an unlinked product causes no Shopify call. Sending an absolute value instead of a [delta](stock-delta.md) is design intent (not stated in the spec), likely so a repeated write cannot apply twice.

## Example
From J04 B-14: catalog and Shopify both hold 10. A device sells 2, and the [push](stock-push.md) sends "set 8, expected 10". Shopify already sold 3, so it holds 7 and refuses the write.

## Known gaps
- The spec does not say which Shopify API or field carries the "expected" value.
- The spec does not say how a refusal is recognised in Shopify's answer.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
