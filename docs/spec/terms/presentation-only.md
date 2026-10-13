---
id: presentation-only
title: Presentation only (not access control)
kind: term
status: draft
aliases: [presentation only]
defined_for: W07-app-shell
rules_hash: 3abb59f83f61
---
# Presentation only (not access control)
## Definition
"Presentation only" means a rule only decides what the interface shows. It does not decide what a user may do. In W07, the [Admin menu entry](navbar-menu-entry.md) is shown only to users with [the role `ADMIN`](shop-role.md), but hiding the entry does not protect the admin pages or their data. Access must still be checked where requests are handled. Hiding a link in the browser is not a [security control ↗](../sw-external-terms.md#access-control), because anyone can type the address or call the API directly.

## Example
Rule W07.R-05: [`isAdmin`](is-admin.md) in `packages/web/lib/admin/is-admin.ts` decides whether the [account menu](navbar.md) lists "Admin" after "Account & security". A user without the role who opens the admin address directly is not stopped by this check.

## Known gaps
- The spec does not say where access to the admin area is actually enforced.
- The spec does not say what a user without the role `ADMIN` sees if they open an admin address directly.

## Used by
<!-- used-by:start -->
- [W07](../capabilities/W07-app-shell.md): R-05
- [is-admin](is-admin.md)
- [navbar-menu-entry](navbar-menu-entry.md)
- [navbar](navbar.md)
- [shop-role](shop-role.md)
<!-- used-by:end -->
