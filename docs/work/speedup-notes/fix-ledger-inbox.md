# The ledger-balances and notifications-inbox failures (both in list 4)

## Ledger-balances ("shards project apart"): chance, not a leftover
The test posts a fee of 30 to PLATFORM_FEES with a random reference. The ledger picks the fee's shard (one of 32) from a hash of that reference. The test then checks shards 3 and 9 of PLATFORM_FEES. In 2 runs out of 32 the fee itself landed on shard 3 (or 9) with balance 30, so the check saw [3,30] instead of [3,5]. Nothing was left over from an earlier file: the Dynamo table is emptied between tests, and the run order did not matter. Small example: a random number from 0 to 31 that happens to be 3 or 9.
Fix: the test now draws references until the hash is not 3 or 9. No check was weakened.

## Notifications-inbox ("rebuilt from the inbox, bounded at 1,000"): too much at once
Error was "inbox store timed out after 1000 ms". The test saves 1,005 items, 25 at the same time, and the store gives each save 1 second. On a busy machine (8 shards) some saves went over. Replayed alone in list 4 order (file 3 of the list) it passed (36 s), so it depends on load, not on a leftover.
Fix: the test saves 5 at a time. The 1 second limit in the product is unchanged.

## Results (shard 8)
Both files together after the fixes: 2 files, 24 of 24 tests passed.
Caution: an earlier replay of the first 36 files of list 4 was still running on shard 8 when I reset the shard a second time (I could not stop it), which gave false failures in one intermediate run (AS-60, AS-61, AS-62). Those are not real; the last run was clean. I did not run the ledger test many times to see the old 6 percent failure, because the cause is clear from the code.
