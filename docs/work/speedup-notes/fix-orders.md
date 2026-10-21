# Orders files: what was wrong and what was changed

## flash-sale-checkout (11 of 18 failed, now 18 of 18 pass)
Cause: the first big test sends 200 buyers at once. The app gives the "fast store" check only 200 ms per call. In a busy single process
some calls took longer, three late calls in a row made a safety switch ("breaker") open, and the switch stays open for 2 s of
*test clock* time. The test clock is frozen, so it never reopened. Every later test then got "rate_limiter_unavailable" (503).
Not caused by today's edit of the spec (the spec edit is fine). Proof: the same run with a 3 s allowance passed 18/18.
Fix: `libs/domains/orders/testing/flash-kit.ts` gives this one test app a 3 s allowance (setting RATE_LIMIT_STORE_TIMEOUT_MS only while the
app starts, then puts it back so other files in the same process are not affected). No check in the spec was changed.

## order-export-backpressure (1 test, ran 60 s and failed)
Cause: the test moves 50,000 lines; it takes 10 to 35 s alone and over 60 s when other test processes use the machine, so it hit the 60 s limit.
Fix: this one test gets a 180 s limit (same as the long journey tests use). Nothing else changed.

## order-export-lifecycle (1 test, read log lines in reverse order)
Could not be reproduced: 15 of 15 pass alone and together with the other two files, with and without TEST_LOGS=1. It looks fixed by the earlier
session's resets (metrics and tracer). No change made.

Result on shard 6: all three files together, 34 of 34 pass. One earlier run of the three together had 2 flash-sale failures
("50 repeated runs" and "AS-06") while the machine was very busy (load about 7); three later runs were all green. Possible leftover flakiness under heavy load.
