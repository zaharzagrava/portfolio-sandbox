---
id: link-stats
title: Link stats
kind: term
status: draft
aliases: [stats]
defined_for: J05-engagement-loop
rules_hash: 0e82ad2a02e2
---
# Link stats
## Definition
Link stats are the figures a link owner reads for their share link through the share links capability (S37), next to its [conversions](referral-conversion.md). Like conversions and `link.converted`, they must not expose who bought through the link. Conversions inside them are credited by attributed paid orders and reversed by a full refund.

## Example
Buyer B reads the stats for their link after friend F bought through it. B sees one conversion (illustrative), but no name, user id or other detail that identifies F.

## Known gaps
- The spec does not say which route serves link stats, or which figures they contain (for example click counts).
- The spec does not say whether clicks without a `ref` on the order appear in the stats. They do not credit the owner.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
