name: cart-odd
specs: S10 W03
minutes: 15
Try to break the cart and checkout: quantity 0, negative, 1000000, decimals, non-numbers (API and UI), the same product added from two tabs, the product's price changing between cart and checkout (seller edits it), stock running out while items are in the cart, checkout twice with the same and with a different idempotency key, cart after sign-out and sign-in, guest cart merge. Out of scope: payment.
