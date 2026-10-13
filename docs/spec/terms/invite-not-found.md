---
id: invite-not-found
title: invite_not_found (404)
kind: term
status: draft
aliases: [invite_not_found]
defined_for: S03-shops-rbac
rules_hash: e3b0c44298fc
---
# invite_not_found (404)
## Definition
`invite_not_found` is the single error that every failed [invite acceptance](invite-acceptance.md) returns, with HTTP `404`. The token may be unknown, expired, [revoked](invite-revoke.md) or already used. The caller's address may not match the invite, or [the shop may not be active](shop-status-gate.md). In every case the answer is identical, so the caller cannot tell which of these happened. The same answer is used for the request that [loses a race ↗](../sw-external-terms.md#race-condition) for one token. Design intent (not stated in the spec): the uniform answer stops anyone from probing which tokens or invites exist. This matches the stated reason for uniform [`shop_not_found`](shop-not-found.md) answers.

## Example
`POST /shop-invites/accept` with a revoked token, and the same call with a token that never existed, both answer `404 invite_not_found` with the same body.

## Known gaps
- Not confirmed in the code: every `invite_not_found` answer counts toward the per-user limit on failed accepts.

## Used by
<!-- used-by:start -->
- [invite-acceptance](invite-acceptance.md)
- [invite-revoke](invite-revoke.md)
- [shop-status-gate](shop-status-gate.md)
<!-- used-by:end -->
