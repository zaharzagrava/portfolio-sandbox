---
id: rendering-failure
title: Rendering failure (error boundary)
kind: term
status: draft
aliases: [error boundary]
defined_for: W07-app-shell
rules_hash: 4b83de3dc1d7
---
# Rendering failure (error boundary)
## Definition
A rendering failure is an error thrown while a page's content is being drawn, for example when an interactive part of the page that runs in the browser throws. The error boundary in `app/error.tsx` (`ErrorPage`) catches it and shows "Something went wrong" inside `<main>` only. The header and footer stay on screen and keep working, so the visitor can still navigate away. If the [root layout](root-layout.md) itself fails, `ErrorPage` does not handle it; the [self-contained error document](self-contained-document.md) does.

## Example
Behavior W07.B-08: a client island on a page throws while rendering. `<main>` now shows "Something went wrong", and the header with its navigation, cart link and [account slot](account-slot.md) is still usable.

## Known gaps
- The spec does not say whether the error state offers a retry action.
- The spec does not say whether the failure is logged or reported anywhere.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-10
- [account-slot](account-slot.md)
- [client-island](client-island.md)
- [error-page](error-page.md)
- [error-state](error-state.md)
- [root-layout](root-layout.md)
- [self-contained-document](self-contained-document.md)
<!-- used-by:end -->
