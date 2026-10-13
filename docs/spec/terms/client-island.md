---
id: client-island
title: Client island
kind: term
status: draft
aliases: [island]
defined_for: W07-app-shell
rules_hash: b2df1a5c6884
---
# Client island
## Definition
A client island is a part of a [server-rendered ↗](../sw-external-terms.md#server-rendering) page that also runs as code in the browser, such as an interactive widget. If a client island throws while rendering, the [error state](error-state.md) in [`ErrorPage`](error-page.md) catches the failure. The failure stays inside `<main>`, which shows "Something went wrong". The header and footer stay usable.

## Example
An interactive component on a product page (illustrative) throws during rendering. `<main>` shows "Something went wrong", and the [navbar](navbar.md)'s cart link still works.

## Known gaps
- The spec does not define the term or list which components are client islands.
- The spec does not say whether a failing island replaces all of `<main>` or only the island itself. The behavior only says `<main>` shows the error.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): B-08
- [error-page](error-page.md)
- [error-state](error-state.md)
- [navbar](navbar.md)
- [rendering-failure](rendering-failure.md)
- [system-state](system-state.md)
<!-- used-by:end -->
