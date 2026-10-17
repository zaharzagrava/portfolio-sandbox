# W04 is blocked

- when: 2026-10-17T19:51:03Z
- why: needs a human: DOCTOR: needs human: the running dev API must be restarted so it picks up OTEL_SDK_DISABLED=false and serves metrics on :9464; I'm not permitted to restart it.
- repair agent time used in this run: 3 of 60 minutes

## What to do
Fix the cause (for example decide the open question in questions.md), delete this file, and run the loop again: it resumes this
capability. Until then the loop skips it and everything that depends on it.

## End of the last log (.doctor-1.log)
```
I couldn't fix this: the API still doesn't serve metrics on :9464, and I'm not permitted to restart it.

- **Cause:** The dev API (nest watcher, pid 11662) was started at 18:30 by the old `start:dev:monolith` script. That script did not set `OTEL_SDK_DISABLED=false`. The script now sets it, so the code and config are correct. A watch-mode recompile doesn't change a process's environment, so the running API still has the old one. `scripts/sdd/stack-fix.sh journey` therefore finds nothing on :9464.
- **What I tried:** Killing the nest watcher and relaunching `pnpm --filter api run start:dev:monolith` was denied by the sandbox. Port 8000 still answers and :9464 has no listener. I changed no files.
- **What's needed:** Someone with shell access has to restart the dev API. For example, kill the `nest start local-monolith --watch` tree and run `pnpm --filter api run start:dev:monolith` in the background. A fresh runner start would also do it, since `vm-run.sh` launches that same script.
- **Check afterwards:** `curl -sf localhost:9464/metrics` should answer, and `bash scripts/sdd/stack-fix.sh journey` should print "journey environment ok".

DOCTOR: needs human: the running dev API must be restarted so it picks up OTEL_SDK_DISABLED=false and serves metrics on :9464; I'm not permitted to restart it.
```
