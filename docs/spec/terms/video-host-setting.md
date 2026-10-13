---
id: video-host-setting
title: VIDEO_HOST
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# VIDEO_HOST
## Definition
`VIDEO_HOST` is a configuration setting of the web app. It is read through the [validated config module](validated-config-module.md), along with settings such as [`MEDIA_HOST`](media-host-setting.md) and [`MAP_TILE_HOST`](map-tile-host-setting.md). The [app shell capability](capability.md) owns it. The name suggests it holds the host that serves video content. That reading is design intent (not stated in the spec).

## Example
The deployment sets the value, and the web app reads it through `packages/web/lib/config.ts#config`:
```
VIDEO_HOST=video.example.com   # illustrative value
```

## Known gaps
- The spec does not say what reads `VIDEO_HOST`. It does not say whether the [Content Security Policy ↗](../sw-external-terms.md#content-security-policy) uses it to allow video sources.
- The spec does not say what form the value takes, for example a bare host name or a full URL with a scheme.
- The spec does not say whether the value is required, or what happens at startup if it is missing.

## Used by
<!-- used-by:start -->
- [capability](capability.md)
- [validated-config-module](validated-config-module.md)
<!-- used-by:end -->
