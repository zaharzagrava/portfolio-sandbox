---
id: scheduled-pull
title: Scheduled pull
kind: term
status: draft
aliases: [pull]
defined_for: J04-catalog-sync-to-search
rules_hash: 19ad05704f2d
---
# Scheduled pull
## Definition
The scheduled pull is the safety net of the Shopify integration. It reads the [connected Shopify store](shopify-connection.md) on a schedule and brings changes into the catalog. A [webhook](shop-webhook.md) is the fast path; the pull finds changes that arrived without a webhook. Like every other source, it writes through the catalog's [exported commands](exported-command.md). It stops when [the shop is not active](shop-status.md).

## Example
A product title is changed in Shopify and no webhook arrives. When the scheduled pull runs, the catalog and public search show the new title (J04 B-07).

## Known gaps
- The spec does not say how often the pull runs or how long a missed change may take to appear.
- The spec does not say whether the pull counts as the "[next trigger](sync-trigger.md)" that repairs Shopify after a `503`.

## Used by
<!-- used-by:start -->
- [J04](../capabilities/J04-catalog-sync-to-search.md): R-08
- [shopify-echo](shopify-echo.md)
- [stock-sync-trigger](stock-sync-trigger.md)
- [sync-trigger](sync-trigger.md)
<!-- used-by:end -->
