---
id: self-contained-document
title: Self-contained error document
kind: term
status: draft
aliases: [self-contained document]
defined_for: W07-app-shell
rules_hash: 47a3cf458a40
---
# Self-contained error document
## Definition
The self-contained error document is the page `GlobalError` (`packages/web/app/global-error.tsx`) shows when the root layout fails. Normally the root layout supplies the `<html>` element and the frame, so this page has to provide its own `<html lang="en">`. It does not rely on the header, footer or any other part of the normal frame. Design intent (not stated in the spec): a failure inside the root layout could also break any part of the frame, so the fallback must not depend on it.

## Example
Rule W07.R-11: `RootLayout` throws while rendering. The visitor gets a complete HTML page from `GlobalError` that starts with its own `<html lang="en">` and has no shared header or footer.

## Known gaps
- The spec does not say what heading or text this document shows.
- The spec does not say whether it offers a retry action or a link back to the home page.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-11
- [rendering-failure](rendering-failure.md)
- [root-layout](root-layout.md)
- [system-state](system-state.md)
<!-- used-by:end -->
