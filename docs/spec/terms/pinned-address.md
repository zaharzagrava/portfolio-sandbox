---
id: pinned-address
title: Pinned address
kind: term
status: draft
aliases: [pinned, pinned-request.ts]
defined_for: S54-platform-toolkit
rules_hash: c5e09917cdab
---
# Pinned address
## Definition
A pinned address is the IP address that an outbound call stays tied to once its hostname has been resolved and checked. In this system the idea comes from [`safeRequest`](safe-http-client.md), which lives in `pinned-request.ts`. The facts state no more about pinning than that file name. In common engineering use, pinning means the connection goes to the exact address that passed the [private-address check](blocked-address.md). A hostname then can't pass the check with a public address and connect to a private one ([DNS rebinding ↗](../sw-external-terms.md#dns-rebinding)). Protecting internal hosts this way is design intent (not stated in the spec).

## Example
The app calls `safeGet` on `https://partner.example/feed` (illustrative). The hostname resolves to `203.0.113.10` (illustrative), which is public, so the check passes. With pinning, the connection goes to `203.0.113.10` even if DNS now answers `10.0.0.5` (illustrative). Without pinning, that second answer could slip past the check that would otherwise fail with `blocked_address`.

## Known gaps
- Not confirmed in the code: that `safeGet` and `safeRequest` connect to the same address they checked. The only hint is the file name `pinned-request.ts`.
- The spec does not say whether [`ResilientHttpClient`](resilient-http.md) pins addresses too, or only checks them.
- The spec does not say how redirects are handled, for example whether each redirect target is resolved, checked and pinned again.

## Used by
<!-- used-by:start -->
- [S28](../capabilities/S28-notifications.md): R-45
- [blocked-address](blocked-address.md)
<!-- used-by:end -->
