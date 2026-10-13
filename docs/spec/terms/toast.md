---
id: toast
title: Toast
kind: term
status: draft
aliases: [toast notification]
defined_for: W01-auth-account
rules_hash: 41d3e0b2c853
---
# Toast
## Definition
A toast is a short, temporary notification that appears over the page without blocking it. In [W01](../capabilities/W01-auth-account.md), a toast tells the member that sign-out failed. The member then stays signed in, and the interface does not switch to the [anonymous state](anonymous-state.md). Using a toast here, rather than an error message shown inside a form, is a design intent (not stated in the spec): **Log out** is chosen from the account menu, where there is no form to hold such a message.

## Example
The member chooses **Log out**, and [`POST /api/bff/session/logout`](post-bff-session-logout.md) fails, for example because there is no network. The navbar still shows the account menu, and a toast reports that sign-out did not work.

## Known gaps
- The spec does not give the toast text or say whether it differs by error (`503`, no network, [`403 csrf_invalid` ↗](../sw-external-terms.md#csrf-token)).
- The spec does not name the toast component or say whether W01 uses toasts anywhere other than a failed sign-out.

## Used by
<!-- used-by:start -->
- [W03](../capabilities/W03-cart-checkout-orders.md): B-02
- [W07](../capabilities/W07-app-shell.md): R-15
- [anonymous-state](anonymous-state.md)
- [form-alert](form-alert.md)
- [page-frame](page-frame.md)
- [post-bff-session-logout](post-bff-session-logout.md)
- [root-layout](root-layout.md)
- [signed-out-notice](signed-out-notice.md)
<!-- used-by:end -->
