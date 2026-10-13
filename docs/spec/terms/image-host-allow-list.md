---
id: image-host-allow-list
title: Image host allow-list
kind: term
status: draft
aliases: [allowed image hosts, configured list]
defined_for: W07-app-shell
rules_hash: 9571caaa923f
---
# Image host allow-list
## Definition
The image host allow-list is the configured list of hosts that the web app's [image component ↗](../sw-external-terms.md#next-image-component) may load images from. If an image's host is not on the list, the [image optimiser ↗](../sw-external-terms.md#image-optimiser) does not render it. Design intent (not stated in the spec): this stops the optimiser from fetching and serving images from any host on the internet.

## Example
A product image whose URL is on the configured media host is rendered by the image component. If the same component gets an image URL on `random-cdn.example` (illustrative), the optimiser does not render it.

## Known gaps
- The spec does not say which configuration value fills the list. [`MEDIA_HOST`](media-host-setting.md) is a likely source, but this is not confirmed.
- The spec does not say what the visitor sees in place of an image that was not rendered.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): B-15
- [media-host-setting](media-host-setting.md)
<!-- used-by:end -->
