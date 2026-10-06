# L01 — JavaScript & TypeScript → where it's used

Rule (D6/D7): only where a feature genuinely needs it.

| Topic (notes 01/01, 01/02) | Implemented in | Status |
|---|---|---|
| Promises: combinators, bounded concurrency (promise pool), error traps (`allSettled` for partial responses) | F-01 `promise-pool.ts`; SD-04 BFF partial responses; SD-09 hydration | planned |
| Async iteration / generators | SD-20 Stripe pagination `for await`; SD-27 streamed export; SD-42 LLM stream | planned |
| Numbers & money (integer minor units, allocation by largest remainder, rounding) | F-01 `money/allocate.ts`; SD-19 multi-shop split; SD-24 proration | planned |
| Dates & time zones (UTC storage, Luxon, DST) | SD-29 cron tz; SD-17 quiet hours; SD-24 billing anchors | planned |
| Closures & memory leaks (bounded maps, listeners cleanup) | F-03 per-connection buffers; SD-34 bounded L1 LRU | planned |
| Workers / SAB / Atomics | not needed by any feature → **skipped** (D6) | n/a |
| ESM vs CJS | Lambda bundles (esbuild, ESM) SD-03 | planned |
| Proxy / Reflect / Symbols | not needed → skipped | n/a |
| Branded / nominal types | F-01 `brand.ts`; IDs in all new domains | planned |
| Discriminated unions + exhaustiveness | order/subscription/auction/delivery/booking state machines (SD-19, 21, 22, 23, 24); SD-29 job types | planned |
| Conditional / mapped / template-literal types | F-03 topic names; F-05 event names → payload map | planned |
| Runtime validation at boundaries (zod) | F-05 envelopes; SD-30/36/44 external payloads; SD-40 function output | planned |
| `satisfies`, `as const` | config/policy tables (SD-28 policies, state transition tables) | planned |
| Module augmentation | Express `Request` augmentation for context (F-01) | planned |
| tsconfig flags | review `strict`, `noUncheckedIndexedAccess` for new libs — logged in DOUBTS if not enabled repo-wide | planned |
