---
id: shopify-scheduled-pull
title: Scheduled pull
kind: term
status: draft
aliases: [pull]
defined_for: J04-catalog-sync-to-search
rules_hash: 0da239e65746
---
# Scheduled pull
## Definition
The scheduled pull is a periodic read of a connected Shopify store that finds changes the [webhook](shop-webhook.md) did not deliver. The webhook is the fast path; the pull is the safety net. A change found by the pull reaches the catalog through its [exported commands](exported-command.md) and then search. Pulls stop when [the shop is not active](shop-status.md). Design intent (not stated in the spec): webhooks can be lost or delayed, so a pull makes the sync [eventually correct ↗](../sw-external-terms.md#eventual-consistency) anyway.

## Example
A product title is changed in Shopify, and no webhook arrives. When the scheduled pull runs, the catalog and public search show the new title.

## Known gaps
- The spec does not say how often the pull runs; the time bounds named in the journey are not defined.
- The spec does not say how the pull decides which changes are new since the last pull.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
