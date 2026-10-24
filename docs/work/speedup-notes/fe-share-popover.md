# Share popover test: flaky position check

What went wrong: the test measured where the Share button sits right after the page loaded, then opened the popover and compared. Parts of the page above the button can still load and push the button around, and the popover also slides in. So the two measurements sometimes came from different moments (popover top 120 vs button bottom 328).

The product was fine: the popover always sits under the button once things stop moving.

Fix (test only, tests/visual/product-panels.spec.ts):
- Wait until the Share button is enabled and its box has not changed for 6 frames before opening.
- After the popover opens, wait for animations to finish and for the popover box to stop changing.
- Measure the button again at that point (through a saved handle, because on a phone the open sheet hides the page from role lookups).
- The checks themselves (narrow, under the button, left edges aligned) are unchanged.
