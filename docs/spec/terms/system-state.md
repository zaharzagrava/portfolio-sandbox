---
id: system-state
title: System state
kind: term
status: draft
aliases: [loading state, not found state, system states]
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# System state
## Definition
A system state is a screen the web app shows instead of normal page content. There are four: not found, error, loading and offline. This capability owns all four, so every other web capability gets the same states. Most of them render inside the [page frame](page-frame.md) and only replace `<main>`, so the header and footer stay usable. One exception: if the [root layout](root-layout.md) itself fails, a [self-contained document](self-contained-document.md) is shown instead. Offline is a notice shown over the page, not a replacement for `<main>`.

## Example
| State | Trigger | What the visitor sees | Rule |
|---|---|---|---|
| Not found | Unknown address | `404`, heading "Page not found" inside the frame | W07.R-09 |
| Error | A [client island](client-island.md) throws | `<main>` shows "Something went wrong" | W07.R-10 |
| Root error | The root layout fails | Its own document with `<html lang="en">` | W07.R-11 |
| Loading | A [loading route](loading-route.md) | Placeholder with `aria-busy="true"` in `<main>` | W07.R-12 |
| Offline | The browser goes offline | `role="status"` notice "You're offline…" | W07.R-14 |

## Known gaps
- The spec does not say which text the error state shows for each status and `code`. It only says the text comes from those two values and never from `title` or `detail`.
- The spec does not say whether the not-found or error states offer a link back, for example to the home page.

## Used by
<!-- used-by:start -->
- [client-island](client-island.md)
- [loading-route](loading-route.md)
- [not-found-state](not-found-state.md)
- [page-frame](page-frame.md)
- [root-layout](root-layout.md)
- [self-contained-document](self-contained-document.md)
<!-- used-by:end -->
