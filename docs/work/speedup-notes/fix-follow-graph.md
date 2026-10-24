# follow-graph repair count flake (not fixed)

What the test expects: after the test breaks 5 things by hand, the repair pass should report at least 6 fixes. A normal run reports 7 (the half-written follow: 3, the stray index entry: 1, the drifted follower count and the stray follower record: 2, the drifted "how many follows" counter of user 1: 1).

What I found:
- The follow() writes are NOT delayed. They are all finished before the call returns, so the "still pending" idea is wrong.
- No background job touches the data during the test (the daily repair job is scheduled for 03:30).
- No subject "failed" in the bad runs (the repair pass counts failures; a slow store call would show up there). So slow database calls are not the cause either. I first guessed that, tried a retry loop in the test, and it did NOT cure the flake (4 still came out), so I reverted it.
- The flake showed up only when the whole machine was also busy (10 busy loops running next to the 4 test copies): 4 of 12 runs got "4 instead of 6". Plain 4-copy rounds passed 36 of 36. My later attempts with logging turned on did not hit it again, so I could not see which 3 fixes were missing (a total of 4 means exactly 3 are missing, most likely the whole half-written user, which is worth 3).

Next step: run the 4 copies together with the busy loops (scratchpad scripts burn.sh and round.sh) and keep the per-user and per-account repair numbers printed until a bad run appears. Then check whether the first pass saw the hand-written "half" row in the user scan.

No code was changed; nothing is committed.

## Second round

- Printed every user and account the repair pass visited, with its count, plus the ids of the half-written user, user 1 and the ghost. Ran 4 copies at once on shards 5 to 8 with 10 to 16 busy loops next to them: about 70 runs, all passed. In every passing run the pass visited exactly the 6 buyers and the accounts and counted 7. So the half-written user WAS seen by the scan every time; the "raw insert not yet visible" idea could not be shown.
- The only 3 bad runs I ever saw (count 4) came right after a command of mine was killed in the middle of a round, so its test processes may still have been running on the same shards (two copies sharing one shard's tables). The repair pass reads the whole shard, so a second copy's pass can fix the first copy's hand-made damage before the first copy counts it. This fits "4" but I cannot prove it (no log kept).
- All printing removed; no code changed; nothing committed.
- Suggestion: before a repro round, check that no earlier vitest is still alive on shards 5 to 8.
