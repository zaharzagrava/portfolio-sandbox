---
id: error-page
title: ErrorPage
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# ErrorPage
## Definition
`ErrorPage` is the web app's error state for a [rendering failure](rendering-failure.md), in `packages/web/app/error.tsx`. When part of a page throws while rendering, `ErrorPage` replaces the content of `<main>` and shows "Something went wrong". The [root layout](root-layout.md) stays in place, so the header and footer stay usable. If the root layout itself fails, `ErrorPage` cannot help, and [`GlobalError`](self-contained-document.md) shows a self-contained error document instead.

## Example
A [client island](client-island.md) on a page throws during rendering. `<main id="main-content">` shows "Something went wrong". The navbar, including the "Cart" link and the footer, still works, so the visitor can leave the broken page.

## Known gaps
- The spec does not say whether `ErrorPage` offers a retry or reset action, or only shows the message.
- The spec does not say whether `ErrorPage` renders through [`<ErrorState>`](error-state.md). So it is not confirmed that its text follows the rule that error text comes only from the status and `code`.
- The spec does not say whether a rendering failure caught by `ErrorPage` is logged or reported anywhere.

## Used by
<!-- used-by:start -->
- [client-island](client-island.md)
- [rendering-failure](rendering-failure.md)
- [root-layout](root-layout.md)
<!-- used-by:end -->
