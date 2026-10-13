---
id: offline-notice
title: Offline notice
kind: term
status: draft
aliases: [offline]
defined_for: W07-app-shell
rules_hash: b447f1480fb4
---
# Offline notice
## Definition
The offline notice is a bar that the [root layout](root-layout.md) renders on every page. When the browser reports that it went offline, the bar appears with the text "You're offline…". The bar has [`role="status"` ↗](../sw-external-terms.md#aria-status-role), so [screen readers ↗](../sw-external-terms.md#assistive-technology) announce it without moving focus. It belongs to the [shared frame](page-frame.md), so individual pages do not build their own offline message.

## Example
A visitor's Wi-Fi drops while they are on `/search`. The browser fires its offline event, and the frame shows:
```html
<div role="status">You're offline…</div>
```

## Known gaps
- The spec does not say what happens when the connection returns. For example, it does not say whether the bar hides by itself.
- The spec does not say whether actions taken while offline are blocked, queued or simply fail.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-14, B-10
- [page-frame](page-frame.md)
- [root-layout](root-layout.md)
<!-- used-by:end -->
