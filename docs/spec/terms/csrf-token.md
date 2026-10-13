---
id: csrf-token
title: CSRF token
kind: term
status: draft
aliases: [__host-bff-csrf cookie]
defined_for: bff-aggregate
rules_hash: 986745bf7652
---
# CSRF token
## Definition
The CSRF token is a value in the [`__Host-bff-csrf` cookie ↗](../sw-external-terms.md#csrf-token), which page scripts can read. A POST authenticated by the [session cookie](session-cookie.md) must copy that value into an `X-CSRF-Token` header. If the header is missing or does not match the cookie, the [BFF ↗](../sw-external-terms.md#bff) answers [`403 csrf_invalid` ↗](../sw-external-terms.md#csrf-token). Requests from clients that send an [`Authorization` header ↗](../sw-external-terms.md#authorization-bearer) do not use this check.

## Example
```
POST /graphql  (illustrative path)
Cookie: __Host-bff-session=Zk3q...; __Host-bff-csrf=t9X2...
X-CSRF-Token: t9X2...
```
The values match, so the request goes ahead. If `X-CSRF-Token` were missing, the BFF would answer `403 csrf_invalid`.

## Known gaps
- The spec does not say when the CSRF token is issued or rotated, for example at login or on a schedule.
- The spec does not say whether other state-changing methods, such as PUT, PATCH or DELETE, are checked too. It only names POST.

## Used by
<!-- used-by:start -->
- [S01](../capabilities/S01-auth-sessions.md): R-29
- [session-cookie](session-cookie.md)
<!-- used-by:end -->
