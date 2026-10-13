---
id: use-suggestions
title: useSuggestions
kind: term
status: draft
aliases: []
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# useSuggestions
## Definition
`useSuggestions` is the front-end [hook ↗](../sw-external-terms.md#react-hook) that gets suggestions for the search box. It sends suggestion requests through the [request throttle](request-throttle.md) and applies [stale response discard](stale-response-discard.md), so only answers for the current text are shown. The [`SearchBox`](search-box.md) component uses it in all three variants: `hero`, `page` and `navbar`. It is in `packages/web/hooks/use-suggestions.ts`.

## Example
A visitor types `iph`, then `ipho`. The answer for `ipho` arrives before the answer for `iph`.
`useSuggestions` shows the `ipho` suggestions in [API order](suggest-ordering.md) and ignores the late `iph` answer (W02.B-03, W02.B-04).

## Known gaps
- Not confirmed in the code: whether `useSuggestions` also handles failed requests (`429`, `400`, `5xx`, invalid body, no connection) by keeping the list closed. The spec does not link rule W02.R-05 to any symbol.
- The spec does not say which backend route the hook calls. It says only "[the suggestions endpoint](get-suggest.md)", so do not assume it is `GET /suggest`.
- The spec does not say whether the hook trims or normalises the text before it sends the request.

## Used by
<!-- used-by:start -->
- [get-suggest](get-suggest.md)
- [request-throttle](request-throttle.md)
- [stale-response-discard](stale-response-discard.md)
- [suggest-ordering](suggest-ordering.md)
<!-- used-by:end -->
