---
id: bootstrap-app
title: bootstrapApp
kind: term
status: draft
aliases: []
defined_for: S54-platform-toolkit
rules_hash: e3b0c44298fc
---
# bootstrapApp
## Definition
`bootstrapApp` is the shared startup function for every backend app in the [platform toolkit](platform-toolkit.md). [`configureHttpApp`](configure-http-app.md) works alongside it and sets up the HTTP pipeline. Because both are shared, every app starts the same way and product teams don't write their own startup code. [Startup validation](startup-validation.md) runs when an app starts, so an app with invalid configuration refuses to start and never begins listening.

## Example
An app starts with three invalid configuration keys (S54.B-16). The app exits with code 1 without opening a port. The log lists the names of the three bad keys but not their values.

## Known gaps
- Not confirmed in the code: which steps `bootstrapApp` runs itself and in what order. Candidates are configuration validation, installing the [crash handlers](crash-handlers.md), setting up the shutdown sequence and starting the [management listener](management-listener.md).
- The spec does not say whether workers with no HTTP surface call `bootstrapApp` and skip only `configureHttpApp`.
- The spec does not say whether `bootstrapApp` marks startup as finished. That event moves `/health/startup` and node readiness to ready, and the spec names only "the startup service" as its owner.

## Used by
<!-- used-by:start -->
- [crash-handlers](crash-handlers.md)
- [management-listener](management-listener.md)
- [platform-toolkit](platform-toolkit.md)
- [startup-validation](startup-validation.md)
<!-- used-by:end -->
