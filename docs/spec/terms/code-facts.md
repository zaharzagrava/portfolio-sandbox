---
id: code-facts
title: Code facts
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# Code facts
## Definition
Code facts are the verified notes taken from the source code that a [capability page](capability.md) is checked against. Each `[[code: path#Symbol]](rule-proof.md)` reference on a page points to one of these facts. When a page names an [entry point](entry-point.md) or link but no matching file is in the code facts, the page marks it as unchecked and lists it under [known gaps](known-gaps.md). This way a reader can tell which statements are backed by code and which come only from the spec.

## Example
`/terms` has a code fact: `[code: packages/web/app/terms/page.tsx#TermsPage]`.
`/privacy` and `/developers/docs` do not. The [W07](../capabilities/W07-app-shell.md) page says "No file of this page is in the facts" for them, and lists them as unchecked.

## Known gaps
- The spec does not say how code facts are collected or verified, or when they are refreshed.
- The spec does not say what happens to a rule when its code fact no longer matches the code.

## Used by
<!-- used-by:start -->
- [J01](../capabilities/J01-buy-to-payout.md): R-17
- [capability](capability.md)
- [entry-point](entry-point.md)
- [known-gaps](known-gaps.md)
- [portfolio-project-sentence](portfolio-project-sentence.md)
- [source-code-url](source-code-url.md)
<!-- used-by:end -->
