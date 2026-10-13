---
id: persisted-query-hash
title: Persisted query hash
kind: term
status: draft
aliases: [hash, known hash]
defined_for: S48-bff
rules_hash: 396f435a5875
---
# Persisted query hash
## Definition
A persisted query hash is a short identifier that the client sends in place of the full [GraphQL document ↗](../sw-external-terms.md#graphql) text. It points to a document on the [BFF ↗](../sw-external-terms.md#bff)'s [trusted-document allowlist](trusted-document-allowlist.md). Outside local development, only allowlisted documents run. When a known hash arrives with GET and no [credential](credential.md), the response can be [cached publicly ↗](../sw-external-terms.md#shared-cache) for a short time. When any credential is present, the response stays private and uncached.

## Example
```
GET /api/graphql?<hash parameter>=<known hash>    (parameter name illustrative)
→ [Cache-Control: public, s-maxage=5 ↗](../sw-external-terms.md#cache-control)      (no credential)
→ Cache-Control: private, no-store       (session cookie or Authorization present)
```

## Known gaps
- The spec does not say which hash algorithm is used or which parameter name carries the hash.
- The spec does not say what an unknown hash returns. AS-37 (trusted documents) is tested but is not written down as a rule.
- The spec does not say how the allowlist is loaded. AS-39 (allowlist startup check) is tested but is not written down as a rule.

## Used by
<!-- used-by:start -->
- [S48](../capabilities/S48-bff.md): B-12
- [credential](credential.md)
- [trusted-document-allowlist](trusted-document-allowlist.md)
<!-- used-by:end -->
