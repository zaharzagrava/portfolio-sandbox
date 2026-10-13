---
id: trusted-document-allowlist
title: Trusted-document allowlist
kind: term
status: draft
aliases: [allowlist, allowlisted documents, trusted documents]
defined_for: S48-bff
rules_hash: e3b0c44298fc
---
# Trusted-document allowlist
## Definition
The trusted-document allowlist is the set of [GraphQL documents ↗](../sw-external-terms.md#graphql) that the [BFF ↗](../sw-external-terms.md#bff) agrees to run. Outside local development, the BFF runs only documents on this list. Clients point to an allowlisted document by a short fingerprint of its text instead of sending the whole document. The allowlist is part of the BFF configuration, and a missing or invalid configuration value stops the process. Design intent (not stated in the spec): clients cannot send arbitrary queries to `/api/graphql`, so only queries reviewed ahead of time can reach the [upstreams](upstream.md).

## Example
A web client sends a known hash with GET and no credentials. The BFF finds the document on the allowlist, runs it, and answers:
```
[Cache-Control: public, s-maxage=5 ↗](../sw-external-terms.md#cache-control)
```
If the request carries [any credential](credential.md), the same document runs, but the answer is `Cache-Control: private, no-store`.

## Known gaps
- The spec does not say what the BFF returns for a document or hash that is not on the allowlist. AS-37 (trusted documents) is tested, but no rule or behavior describes it.
- The spec does not say how the allowlist is built, where it is stored, or what the startup check verifies. AS-39 (allowlist startup check) is tested but is not written down as a rule.
- The spec does not say how "local development" is detected, so it is unclear when the allowlist is enforced.

## Used by
<!-- used-by:start -->
- [credential](credential.md)
- [graphql-introspection](graphql-introspection.md)
- [introspection-disabled](introspection-disabled.md)
- [persisted-query-hash](persisted-query-hash.md)
- [post-api-graphql](post-api-graphql.md)
- [production-configuration](production-configuration.md)
- [upstream](upstream.md)
<!-- used-by:end -->
