---
id: html-allow-list-sanitiser
title: Allow-list sanitiser
kind: term
status: draft
aliases: [allow-list, sanitiser]
defined_for: W02-storefront-discovery
rules_hash: d3e33f40684a
---
# Allow-list sanitiser
## Definition
The allow-list sanitiser is the web-app function that cleans HTML before it reaches the [DOM ↗](../sw-external-terms.md#dom). It is `sanitizeBodyHtml` in `packages/web/lib/safe-html.ts`. It keeps only markup on its allow-list and removes everything else. Every [`bodyHtml`](body-html.md) value must pass through it. Design intent (not stated in the spec): to block [script injection ↗](../sw-external-terms.md#cross-site-scripting) from user-written content.

## Example
Input: `<p>Hi <b>there</b></p><img src=x onerror=alert(1)>`
The output keeps only the allowed tags and attributes, for example `<p>Hi <b>there</b></p>` (illustrative; the real list is not given).

## Known gaps
- The spec does not say which tags and attributes are on the allow-list, or how links and images are handled.
- The spec does not say which library, if any, the sanitiser is built on.

## Used by
<!-- used-by:start -->
- [W02](../capabilities/W02-storefront-discovery.md): R-20
- [body-html](body-html.md)
- [product-discussions](product-discussions.md)
<!-- used-by:end -->
