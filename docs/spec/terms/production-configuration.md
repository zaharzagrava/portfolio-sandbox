---
id: production-configuration
title: Production configuration
kind: term
status: draft
aliases: [production]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# Production configuration
## Definition
Production configuration is the set of [BFF ↗](../sw-external-terms.md#bff) settings used when the service runs in production. It switches off [GraphQL introspection ↗](../sw-external-terms.md#graphql-introspection), so an introspection query gets [`INTROSPECTION_DISABLED`](introspection-disabled.md). The BFF's settings include the [domain-API origin](domain-api-origin.md), session encryption keys, allowed origins, [budgets](section-budget.md), limits and the [trusted-document allowlist](trusted-document-allowlist.md). If a setting is missing or invalid, the process stops at startup.

## Example
In production, `{ __schema { types { name } } }` sent to `/api/graphql` gets `INTROSPECTION_DISABLED` and 0 upstream calls. A separate rule says that outside local development, only documents on the trusted-document allowlist run.

## Known gaps
- The spec does not say how the BFF knows it is running in production (for example, which setting or environment variable it reads).
- The spec does not say whether "production configuration" and "outside local development" are the same condition. For example, it does not say whether a staging environment allows introspection.
- Not confirmed in the code: whether `parseBffSettings` also controls the introspection switch, or whether a separate setting does.

## Used by
<!-- used-by:start -->
- [domain-api-origin](domain-api-origin.md)
- [graphql-introspection](graphql-introspection.md)
- [introspection-disabled](introspection-disabled.md)
- [main-journeys](main-journeys.md)
- [section-budget](section-budget.md)
- [trusted-document-allowlist](trusted-document-allowlist.md)
<!-- used-by:end -->
