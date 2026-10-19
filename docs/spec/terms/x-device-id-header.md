---
id: x-device-id-header
title: X-Device-Id header
kind: term
status: draft
aliases: [x-device-id]
defined_for: J04-catalog-sync-to-search
rules_hash: 3e6d6020681d
---
# X-Device-Id header
## Definition
`X-Device-Id` is the request header a [till device](till.md) sends when it pulls the [device feed](device-feed.md). It names the device that is asking. The device sends it together with its [cursor](pagination-cursor.md). [Cross-tenant rules](cross-tenant-bypass.md) still apply: a route of one shop must not reach another shop's device sync, and the answer is `404` or `403`.

## Example
Device `D2` pulled at cursor `C0` before a sale. It pulls again with `C0` and its device id:
```
X-Device-Id: D2   (illustrative value)
```
The device feed answers with an entry for `Ps` that carries the new quantity.

## Known gaps
- The spec does not say what the server does with the header, such as per-device cursor tracking or registration checks.
- The spec does not say what happens when the header is missing or unknown, or whether [sale pushes](device-sale.md) also need it.
- The spec does not give the header's value format.

## Used by
<!-- used-by:start -->
_nobody yet_
<!-- used-by:end -->
