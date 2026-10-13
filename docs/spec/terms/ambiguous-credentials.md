---
id: ambiguous-credentials
title: Ambiguous credentials
kind: term
status: draft
aliases: [ambiguous_credentials]
defined_for: bff-aggregate
rules_hash: e3b0c44298fc
---
# Ambiguous credentials
## Definition
`ambiguous_credentials` is the error code the [BFF ↗](../sw-external-terms.md#bff) returns, with status `400`, when one request carries both a [session cookie](session-cookie.md) and an [`Authorization` header ↗](../sw-external-terms.md#authorization-bearer). Instead of picking one of the two identities, the BFF refuses the request. Picking silently could act for the wrong user. That reason is design intent (not stated in the spec).

## Example
```
POST /graphql  (illustrative path)
Cookie: __Host-bff-session=Zk3q...
Authorization: Bearer eyJ...
```
→ `400 ambiguous_credentials`, and [no upstream is called](upstream.md).

## Known gaps
- The spec does not say what the response body looks like.
- The spec does not say whether this check runs before or after the [CSRF check ↗](../sw-external-terms.md#csrf-token).

## Used by
<!-- used-by:start -->
- [session-cookie](session-cookie.md)
- [upstream](upstream.md)
<!-- used-by:end -->
