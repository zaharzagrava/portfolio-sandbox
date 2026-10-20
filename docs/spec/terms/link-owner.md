---
id: link-owner
title: Link owner
kind: term
status: draft
aliases: [owner]
defined_for: J05-engagement-loop
rules_hash: 813234fe9a1f
---
# Link owner
## Definition
The link owner is the user who created a share link. They are the one credited with a conversion when an attributed order is paid. The owner can read the [link's stats](link-stats.md) and conversions, but these never reveal who bought (J05.R-20). If the owner checks out with their own link, the answer carries `attribution: null` and no conversion is created. Blocking self-credit is design intent (not stated in the spec).

## Example
B creates a link and shares it. Friend F buys through it, and B, the link owner, gains one conversion without learning F's identity. If B checks out with that same link, the order gets `attribution: null` (J05 AS-16).

## Known gaps
- The spec does not say which roles may own a link: buyers only, or also sellers.
- The spec does not say which fields of stats or [`link.converted`](link-converted-event.md) the owner sees. It only says the buyer's identity is never among them.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
