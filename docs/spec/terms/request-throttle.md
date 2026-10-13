---
id: request-throttle
title: Request throttle
kind: term
status: draft
aliases: [throttle]
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# Request throttle
## Definition
The request throttle caps how often the [search box](search-box.md) asks for suggestions while a visitor types. However fast the visitor types, the box sends no more than one suggestion request per throttle interval. It works together with [stale response discard](stale-response-discard.md), which drops late answers for old text. Both live in [`useSuggestions`](use-suggestions.md). Design intent (not stated in the spec): this keeps suggestion traffic and [rate-limit pressure](rate-limit.md) low without making the list feel slow.

## Example
A visitor types `i`, `p`, `h` quickly into the `hero` search box, all within 150 ms.
The box sends at most one suggestion request for that stretch of typing (W02.R-04), not three.

## Known gaps
- The spec does not say whether this is a throttle (send the first keystroke, then wait) or a [debounce ↗](../sw-external-terms.md#debounce) (wait for a pause, then send). "At most one per 150 ms of typing" fits both.
- The spec does not say whether the request after the interval always carries the latest typed text.
- Not confirmed in the code: whether an empty or whitespace-only box sends a request at all.

## Used by
<!-- used-by:start -->
- [rate-limit](rate-limit.md)
- [search-box](search-box.md)
- [stale-response-discard](stale-response-discard.md)
- [use-suggestions](use-suggestions.md)
<!-- used-by:end -->
