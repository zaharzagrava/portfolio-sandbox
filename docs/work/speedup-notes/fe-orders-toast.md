# Orders: the missing "Order cancelled" message

What went wrong: when you press "Cancel order", the page can learn the order is cancelled by its live status
update BEFORE the server's answer to the click reaches the dialog. The page then removes the Cancel button, and
the dialog goes away with it. The code that showed the "Order cancelled" message was attached to the click request
itself, and that library drops such follow-up code when the dialog is already gone. So the order was cancelled but
the person was never told. About 1 run in 3 in the test.

Fix (components/orders/cancel-order-dialog.tsx): wait for the answer with a promise (mutateAsync ... then) instead
of callbacks tied to the dialog, so the message (and the error messages) always show. The test is unchanged.

Note: I could not see it fail in my own 8 runs (they all passed, before and after), because the timing is luck;
the cause is from reading the code and the symptom described. Also the dev web server on port 3000 went down during my
first run; Playwright started its own for the later runs.
