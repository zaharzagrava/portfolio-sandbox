---
id: stale-response-discard
title: Stale response discard
kind: term
status: draft
aliases: [out of order, out-of-order answers]
defined_for: W02-storefront-discovery
rules_hash: dc6790b810b2
---
# Stale response discard
## Definition
Stale response discard is how the search box handles suggestion answers that arrive late. Each answer belongs to the [prefix](suggest-prefix.md) it was requested for. If that prefix no longer matches the current text in the box, the answer is ignored. This stops an older, slower answer from replacing the list for newer text. It is implemented in [`useSuggestions`](use-suggestions.md) (`packages/web/hooks/use-suggestions.ts`), together with the logic that limits how often suggestion requests are sent.

## Example
The visitor types `iph`, then `ipho`. The answer for `ipho` arrives first, and the answer for `iph` arrives later.
The list keeps showing the suggestions for `ipho`, and the late `iph` answer is dropped.

## Known gaps
- Not confirmed in the code: whether the check uses the `prefix` member of the [suggest response](get-suggest.md) or the text the client remembers sending.
- The spec does not say whether the comparison uses the trimmed or [normalised](normalised-text.md) text, or the raw box text.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): B-04
- [get-suggest](get-suggest.md)
- [normalised-text](normalised-text.md)
- [request-throttle](request-throttle.md)
- [search-box](search-box.md)
- [server-rendered-search](server-rendered-search.md)
- [shop-version](shop-version.md)
- [suggest-prefix](suggest-prefix.md)
- [use-suggestions](use-suggestions.md)
<!-- used-by:end -->
