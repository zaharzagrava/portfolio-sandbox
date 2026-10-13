---
id: blocked-address
title: blocked_address
kind: term
status: draft
aliases: []
defined_for: S54-platform-toolkit
rules_hash: d57540c06f8d
---
# blocked_address
## Definition
`blocked_address` is the failure [`safeGet`](safe-http-client.md) returns when the target hostname resolves to a private address. The request to that address is not sent. Its purpose is to stop outbound calls from reaching internal hosts, a defence against [server-side request forgery ↗](../sw-external-terms.md#ssrf). That purpose is design intent (not stated in the spec).

## Example
A webhook URL uses the hostname `internal.example` (illustrative), which resolves to `10.0.0.5` (illustrative). The app calls `safeGet` on that URL, and the call fails with `blocked_address` without connecting.

## Known gaps
- The spec does not say which address ranges count as "private" (for example loopback, link-local or IPv6 ranges).
- The spec does not say whether `safeRequest` and [`ResilientHttpClient`](resilient-http.md) also fail with `blocked_address`, or how the error reaches an API client (status and [problem+json ↗](../sw-external-terms.md#problem-json) `code`).
- Not confirmed in the code: whether the address that was checked is the one the connection uses (["pinned"](pinned-address.md)), which would block [DNS-rebinding ↗](../sw-external-terms.md#dns-rebinding) tricks. The file name `pinned-request.ts` suggests it, but the facts don't state it.

## Used by
<!-- used-by:start -->
- [pinned-address](pinned-address.md)
- [sso-issuer-errors](sso-issuer-errors.md)
<!-- used-by:end -->
