# Gaps between test files: what they are

Finding: the big gaps are NOT teardown. They are the time the test runner needs to load (import and convert) the NEXT file's code.

How I checked (shard 7, three of the big-gap files run together):
- A temporary timer in the setup file showed the end of video-pipeline's last cleanup to the start of the next file: about 0.01 s. No shutdown wait, no Kafka leave, no Redis wait.
- The runner's own "start time" of a file is taken AFTER the file is loaded. video-pipeline alone: load 12.5-13 s (about 2,700 source files converted and run, of which 6.9 s is conversion), then 31 s of tests. In the combined run the "gap" before it was 14.2 s, matching the load time.
- outbox-cdc is skipped (1 skipped test), so it costs nothing itself; the 11.7 s "after" it is the load of the file that follows it.
- product-invalidation: gap after video-pipeline 0.25 s (modules already loaded and cached), the file itself 1.7 s.

Meaning: because all files share one process, each source file is converted once, by the first file that needs it. The "big gap" lands on whichever file first pulls in a large new set of modules (the whole app). It is a fixed cost, moves to another file if the order changes, and cannot be removed by shortening a shutdown timeout.

Changes made: none (setup file restored to original). No test-only timeout reduction would help here.

Ideas that could cut it (not done, they change the runner setup): a persistent on-disk cache of converted files (needs a newer Vitest than 3.2.7), or warming the converted-file cache in the background while earlier files run.
