# S30 is blocked

- when: 2026-10-13T21:30:40Z
- why: needs a human: DOCTOR: needs human: install ffmpeg and ffprobe (>= 5) on the runner so T064 and T065 can be proven, because package installation was denied to the agent.
- repair agent time used in this run: 0 of 60 minutes

## What to do
Fix the cause (for example decide the open question in questions.md), delete this file, and run the loop again: it resumes this
capability. Until then the loop skips it and everything that depends on it.

## End of the last log (.doctor-1.log)
```
S30 can't be fixed from here: T064 and T065 (AS-18 and AS-19) need a real `ffmpeg` and `ffprobe`, and this runner has neither. The tests for both are already written in `video-pipeline.e2e-spec.ts`, so no spec, plan or task is wrong.

I tried to install `ffmpeg` with `apt-get`, and the sandbox refused. I did not retry or work around that. I didn't tick the tasks, because the proof can't run here and ticking them would fake it. I also changed no files.

The block is already on record:
- `specs/domains/S30-video/questions.md` line 64 has a `[BLOCKED]` note.
- `specs/UNVERIFIED.md` has the S30 row, status "not run".

A human needs to install ffmpeg 5 or newer on the runner. Then run `scripts/sdd/test-spec.sh libs/domains/media/video-pipeline.e2e-spec.ts` from `packages/backend`. Once the seven skipped tests pass, tick T064 and T065 and drop the UNVERIFIED row.

DOCTOR: needs human: install ffmpeg and ffprobe (>= 5) on the runner so T064 and T065 can be proven, because package installation was denied to the agent.
```
