# Seller overview picture (phone) sometimes 44 px too short

What went wrong: the "Last 60 seconds" box grows by a strip of little bars (32 px plus 12 px gap = 44 px)
when its first live update arrives. The picture on disk was taken with that strip. In the failing run the
screenshot was taken a moment before the first update, so the box was shorter and the whole page was 44 px shorter.
(The box itself is hidden by a pink mask, but its height still moves everything below it.)

Fix (test only): before taking any picture in seller-overview.spec.ts, wait until the live box shows its bar strip
(the image inside the "Last 60 seconds" region). No threshold or mask change, no new baseline: the saved picture was
already in the right (with-strip) state.

Product note: a real user sees a 44 px jump when the first update arrives. A fixed-height placeholder for the strip
would remove it; not done here because it would change all 6 saved pictures.

Caveat: the "new shop" test (line ~101) failed once in my first repeat run right after the fix. I could not read
why: the dev stack (ports 3000 and 8000) went down during my run, so I could not re-run. It may be the same wait
needs (a new shop may never send a frame with the strip?) - check first.
