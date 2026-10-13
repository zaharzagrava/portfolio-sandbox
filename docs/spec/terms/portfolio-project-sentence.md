---
id: portfolio-project-sentence
title: Portfolio-project sentence
kind: term
status: draft
aliases: [portfolio project]
defined_for: W07-app-shell
rules_hash: c1f8fe40e837
---
# Portfolio-project sentence
## Definition
The portfolio-project sentence is a fixed line of text in the footer. It is shown on every page as part of the [page frame](page-frame.md). It tells visitors that the site is a portfolio project. It sits next to the "Footer" navigation.

## Example
Rule W07.R-08: the `Footer` component (`packages/web/components/layout/footer.tsx`) renders the portfolio-project sentence and a [navigation landmark ↗](../sw-external-terms.md#navigation-landmark) named "Footer".

## Known gaps
- The spec does not say the exact wording of the sentence.
- The spec does not say which links the "Footer" navigation contains. The footer's Source code link ([`SOURCE_CODE_URL`](source-code-url.md)) is not in the [code facts](code-facts.md).

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-08
- [code-facts](code-facts.md)
- [page-frame](page-frame.md)
<!-- used-by:end -->
