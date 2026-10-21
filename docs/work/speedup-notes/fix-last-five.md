# The last five failures (partly done)

All five pass when run alone on shard 6. Only one could be reproduced in sequence.

jobs-observability (AS-78): FIXED. The duration histogram was created once and kept for the whole process, so it stayed attached to whatever metrics provider existed at that moment. Earlier job files used it before this file installed its own provider, so the new provider never saw it. Now the histogram is re-created when the provider changes (libs/infrastructure/jobs/job-metrics.ts). The spec also drops an earlier global provider before installing its own, and removes its own afterwards. All 9 job files together: 99 of 99 pass.

distributed-lock (AS-61): not reproduced alone (20 of 20 pass). The count it checks (at most 45 store commands in about 300 ms of waiting) comes from the whole server's command counter, so any other client writing to the same shard Redis at that moment (leftovers of earlier files in the same process) adds to it. A real waiter makes about 12 attempts, so the bound itself is sensible and was not changed; the counting is what is noisy. Not fixed yet: the counter should count only this client's commands.

live-reactions, usage-read, flash-sale-public: each passes alone (21, 17, 10). The old failure logs were overwritten by the newer run, and a combined run of all five folders hit the 3-minute limit, so the sequence causes were not found.
