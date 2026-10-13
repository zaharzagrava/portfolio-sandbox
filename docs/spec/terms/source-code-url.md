---
id: source-code-url
title: SOURCE_CODE_URL
kind: term
status: draft
aliases: [source code link]
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# SOURCE_CODE_URL
## Definition
`SOURCE_CODE_URL` is a configuration value of the web app. It is read through the [single validated configuration module](validated-config-module.md), together with the other web settings that [W07](../capabilities/W07-app-shell.md) owns. The footer's "Source code" link points to the address this value holds.

## Example
`SOURCE_CODE_URL` appears in the configuration list owned by W07, next to `SITE_URL`, `API_URL` and [`MEDIA_HOST`](media-host-setting.md). All of them are read through `config` in `packages/web/lib/config.ts`.

## Known gaps
- Not confirmed in the code: the footer's "Source code" link that uses `SOURCE_CODE_URL` is not in the [code facts](code-facts.md). The link is listed as [unchecked](known-gaps.md).
- The spec does not say if the value is required, or what the footer shows when the value is missing.
- The spec does not say what checks the configuration module runs on this value.

## Used by
<!-- used-by:start -->
- [code-facts](code-facts.md)
- [known-gaps](known-gaps.md)
- [validated-config-module](validated-config-module.md)
<!-- used-by:end -->
