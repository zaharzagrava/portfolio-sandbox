# Fix: "expected 0 to be greater than 0" in four specs (shared process)

What failed: the ads-platform log check, the discussions-resilience, launch-events-operations and courier-locations checks. All of them read what the app wrote while a test ran, and found nothing. They passed alone.

Cause: the logging library (nestjs-pino) builds ONE logger for the whole process and every later app reuses it. When a worker or projector wiring spec ran first, that logger was tied to the real output. A later spec that listens on the output to read the logs then saw nothing, because the logger was not writing through the listened-to output. The counters themselves were fine (nobody resets the metrics registry any more).

Fix: test/e2e-env.setup.ts now makes the library forget its single logger at the start and the end of every spec file, so each file's apps build a fresh logger (the library does not export this reset, so it is reached by file path, for both module copies).

Check on shard 6: the five wiring specs (worker and projector) followed by ads-platform: 29 tests pass (before the fix the ads log check and the ads instruments check failed).
