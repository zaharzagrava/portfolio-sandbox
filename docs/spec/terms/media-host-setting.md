---
id: media-host-setting
title: MEDIA_HOST
kind: term
status: draft
aliases: []
defined_for: W07-app-shell
rules_hash: e3b0c44298fc
---
# MEDIA_HOST
## Definition
`MEDIA_HOST` is a configuration setting of the web app. It is read through the [validated config module](validated-config-module.md), together with settings such as [`VIDEO_HOST`](video-host-setting.md) and [`MAP_TILE_HOST`](map-tile-host-setting.md). The [app shell capability](capability.md) owns it. Its name suggests it holds the host that serves media files, such as product images. That reading is design intent (not stated in the spec).

## Example
The deployment sets the value, and the web app reads it through `packages/web/lib/config.ts#config`:
```
MEDIA_HOST=media.example.com   # illustrative value
```

## Known gaps
- The spec does not say what reads `MEDIA_HOST`. It does not link it to the [image host allow-list](image-host-allow-list.md) or to the [Content Security Policy ↗](../sw-external-terms.md#content-security-policy).
- The spec does not say what format the value takes, such as a bare host name or a full URL with a scheme.
- The spec does not say whether the value is required or what happens at startup if it is missing.

## Used by
<!-- used-by:start -->
- [capability](capability.md)
- [image-host-allow-list](image-host-allow-list.md)
- [validated-config-module](validated-config-module.md)
<!-- used-by:end -->
