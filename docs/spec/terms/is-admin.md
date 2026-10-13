---
id: is-admin
title: isAdmin
kind: term
status: draft
aliases: [is-admin.ts]
defined_for: W07-app-shell
rules_hash: 8f483675f430
---
# isAdmin
## Definition
`isAdmin` is the web app check that decides whether the signed-in user has [the role `ADMIN`](shop-role.md). [The account menu](navbar.md) uses its answer to decide whether to show the [Admin entry](navbar-menu-entry.md). [The check is presentation only](presentation-only.md), so it changes what the menu shows but does not protect anything. [The real access check ↗](../sw-external-terms.md#access-control) must happen where requests are handled.

## Example
Rule W07.R-05 points to `isAdmin` in `packages/web/lib/admin/is-admin.ts`. For a member with the role `ADMIN`, the account menu lists "Admin" after "Account & security" (behavior W07.B-04). For any other member, the entry is not shown.

## Known gaps
- The spec does not say what input `isAdmin` takes, for example a session, a user object or a role string.
- The spec does not say where access to the admin area is actually enforced on the server.
- The spec does not say what a user without the role `ADMIN` sees if they open an admin address directly.

## Used by
<!-- used-by:start -->
- [S03](../capabilities/S03-shops-rbac.md): B-22
- [navbar-menu-entry](navbar-menu-entry.md)
- [navbar](navbar.md)
- [presentation-only](presentation-only.md)
- [shop-role](shop-role.md)
<!-- used-by:end -->
