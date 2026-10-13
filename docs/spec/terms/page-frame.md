---
id: page-frame
title: Page frame
kind: term
status: draft
aliases: [frame]
defined_for: W07-app-shell
rules_hash: 9f8be7def689
---
# Page frame
## Definition
The page frame is the shared layout around the content of every page in the web app. It is made of the skip link, the header, the single `<main id="main-content">`, the footer, the [toast area](toast.md) and a banner that tells visitors when they have lost their connection. The [root layout](root-layout.md) renders it, so each page only fills `<main>`. The full-page screens for not found, error and loading also appear inside the frame, so visitors keep the header and footer.

## Example
For an unknown address such as `/no-such-page` (illustrative), the response is `404`. The header and footer still render, and `<main>` shows the heading "Page not found" (W07.R-09, `[NotFoundState](not-found-state.md)`).

## Known gaps
- The spec does not say whether the legal pages (`/terms`, `/privacy`) or `/developers/docs` add anything inside the frame. AS-25, the legal page layout scenario, has no test.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-09
- [not-found-state](not-found-state.md)
- [offline-notice](offline-notice.md)
- [portfolio-project-sentence](portfolio-project-sentence.md)
- [root-layout](root-layout.md)
- [system-state](system-state.md)
- [toast](toast.md)
<!-- used-by:end -->
