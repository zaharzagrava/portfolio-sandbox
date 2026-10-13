---
id: body-html
title: bodyHtml
kind: term
status: draft
aliases: []
defined_for: W02-storefront-discovery
rules_hash: e3b0c44298fc
---
# bodyHtml
## Definition
`bodyHtml` is a field that carries content as raw HTML for a page of the storefront. The web app never puts it into the DOM directly. It must first pass through the [allow-list sanitiser](html-allow-list-sanitiser.md) ([`sanitizeBodyHtml`](html-allow-list-sanitiser.md)). The rule's [proof scenario](rule-proof.md) is in the Discussions scenario range. The [known gaps](known-gaps.md) also list the sanitiser tests under Discussions, so the field most likely holds discussion content.

## Example
```json
{ "bodyHtml": "<p>Works great</p><script>alert(1)</script>" }
```
Only the allowed markup, here `<p>Works great</p>`, reaches the DOM (illustrative value).

## Known gaps
- The spec does not say which [section of the page aggregate](page-aggregate.md), or which object, owns `bodyHtml`.
- The spec does not say who writes this HTML (shoppers, sellers or the backend), or whether the backend sanitises it too.

## Used by
<!-- used-by:start -->
- [html-allow-list-sanitiser](html-allow-list-sanitiser.md)
- [known-gaps](known-gaps.md)
- [page-aggregate](page-aggregate.md)
- [rule-proof](rule-proof.md)
<!-- used-by:end -->
