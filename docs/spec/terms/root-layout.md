---
id: root-layout
title: Root layout
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: 7dcaac2caeed
---
# Root layout
## Definition
The root layout is the outermost layout component of the web app, `RootLayout` in `packages/web/app/layout.tsx`. It wraps every page and draws the parts every page shares: the [skip link ↗](../sw-external-terms.md#skip-link), header, `<main>`, footer, [toast area](toast.md) and a banner that tells the user they have lost their connection. Because every page passes through it, the shared layout and accessibility baseline live in one place. If the root layout itself fails, nothing it renders can be trusted, so the [self-contained error document](self-contained-document.md) is shown instead.

## Example
```
RootLayout
├─ SkipLink        "Skip to main content"
├─ header          (Navbar)
├─ <main id="main-content">  ← the page's own content
├─ Footer
├─ toast area      (at most 3 visible)
└─ OfflineNotice
```

## Known gaps
- Not confirmed in the code: the exact order of the toast area and the offline notice inside the layout. The tree above follows the order the spec lists them in.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-11
- [error-page](error-page.md)
- [loading-route](loading-route.md)
- [offline-notice](offline-notice.md)
- [page-frame](page-frame.md)
- [page-skeleton](page-skeleton.md)
- [rendering-failure](rendering-failure.md)
- [self-contained-document](self-contained-document.md)
- [system-state](system-state.md)
- [toast](toast.md)
<!-- used-by:end -->
