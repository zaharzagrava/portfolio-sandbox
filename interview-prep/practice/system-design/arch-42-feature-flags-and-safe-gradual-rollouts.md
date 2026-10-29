# arch-42. Feature flags and safe gradual rollouts

*Reliability · Medium*

## The question

"Our social app (web, iOS, Android; 400 API pods; ~50k requests/s at peak) ships behind feature flags, but today flags are environment variables, so every change is a deploy. Design a feature flag service: per-user and percentage rollouts, targeting by country, app version and staff, kill switches that take effect in seconds, and a safe way to roll out risky changes gradually."

**Then:** "Last week someone moved a flag from 5% to 100% by mistake and the database fell over. How do you stop that happening again, and how fast can you turn it off?"

Try it first: talk through clarify → design → deep dives out loud, then open the answer.

<details>
<summary>Model answer</summary>

## Clarifying questions

- How many flag checks? → assume: ~20 per request, so ~1M evaluations/s at peak. Evaluation must be in-process, no network call.
- Kinds of flags? → assume: release flags (temporary), experiments, ops kill switches (long-lived). Paid entitlements are product data, not flags.
- Propagation target? → assume: kill switches < 5 s on servers; mobile apps on the next foreground or within a minute.
- Build or buy (LaunchDarkly, Unleash, Flagsmith, AWS AppConfig)? → assume: the design holds either way; I'll describe the mechanics.
- Old mobile versions? → assume: users on app versions up to 6 months old; flags must target by app version.
- Who changes flags? → assume: engineers and product managers through a UI; production changes are audited, risky ones need approval.

## Design

1. **Flag store**: Postgres in the flag service, the source of truth.
```sql
flags(key text PRIMARY KEY, kind text, owner text, expires_on date,
      default_variant text, risk text, archived boolean)
flag_configs(flag_key text, env text, version int, rules jsonb,
             updated_by text, reason text, updated_at timestamptz,
             PRIMARY KEY (flag_key, env, version))       -- every change is a new version
```
Rules are ordered: `[{if: {staff: true}, serve: "on"}, {if: {appVersion: {gte: "5.12.0"}, country: {in: ["DE","FR"]}}, rollout: {on: 5}}]`, else default.
2. **Distribution.** Per environment the service publishes a versioned snapshot of all rules (a few hundred KB) to S3 and pushes change events over an SSE stream. The server SDK in each pod loads the snapshot at startup, keeps it in memory, applies stream updates, and polls every 30 s as a safety net.
3. **Evaluation** is a pure function over in-memory rules: microseconds, no I/O.
4. **Bucketing.** `bucket = murmur3(flagKey + ":" + salt + ":" + userId) % 10000`; the user is in if `bucket < percent × 100`. Deterministic, so a user sees the same variant on every pod, restart and device; raising 5% to 25% keeps the first 5% in. Bucket by the unit that must agree: `userId` for personal features, `groupId` for a feature every member of a group chat must see.
5. **Clients.** Browsers and mobile apps never get the rules. The API evaluates for the user and returns `{flags}` at session start and on app foreground; the app caches the last values; code defaults are the safe path.
6. **Kill switches** are ops flags whose default is the safe behaviour, checked right at the risky code path. They propagate through the stream in ~1-2 s.
7. **Progressive rollout with guardrails.** A rollout plan (1% → 5% → 25% → 50% → 100%, minimum soak per step). Exposures `(flag, variant, userId)` are logged at evaluation, so error rate, p99, DB load, crash-free sessions and a key product metric are compared by variant. A breach pauses the plan and reverts the last step automatically.
8. **Failure mode: fail static.** Flag service down → pods keep the last snapshot; new pods start from the S3 copy; no snapshot at all → code defaults. Startup never blocks on the flag service.
9. **Hygiene.** Release flags have an owner and expiry; a weekly report lists flags at 100% for 30+ days; CI fails on references to archived flags.

## Deep dives

**1. Local evaluation vs a remote call.** At 1M evaluations/s, a network call per check adds latency to every request and makes the flag service a hard dependency of the whole app. A Redis lookup per check is still 20 network hops per request. Chosen: an in-process snapshot with streamed updates. The cost: during a change, pods disagree for a second or two, which is fine for flags.

**2. Canary deploy vs flag rollout.** A canary puts a new binary on a few pods and catches crashes and regressions in code that always runs. A flag rollout gives new behaviour to a percentage of users wherever they land, sticky per user, and catches user-facing and data-dependent problems. Use both: deploy dark (flag off) through a canary, then roll the flag. Note that a percentage of users is not the same percentage of DB load: a new query path with a cold cache can cost far more per user than the old one, which is why DB load is a guardrail.

**3. Why salt per flag.** With the same hash for every flag, the same 5% of users are first in every rollout. They absorb every bug, and experiments running together are correlated, so their results can't be separated. A per-flag salt spreads both.

## Traps

- Calling the flag service over the network on every check.
- Bucketing with `Math.random()`: a user flips between variants on every request.
- Shipping the full rule set to browsers or apps: it leaks unreleased features and targeting.
- Blocking startup on the flag service, or having no default when it's unreachable.
- Using flags as permanent config or paid entitlements; never removing them.
- One hash for all flags: the same users are always first.

## Say it (60–90 s)

Flags are checked about twenty times per request, so a million times a second at peak, which means evaluation has to be in-process. The flag service stores rules in Postgres, with every change a new audited version, and publishes a snapshot per environment to S3 plus change events over a server-sent events stream. Each pod's SDK loads the snapshot, keeps it in memory, applies updates and polls as a safety net, so evaluation is a pure function in microseconds and a kill switch reaches all pods in a second or two. Percentage rollouts use a hash of the flag key, a per-flag salt and the user ID, so a user always gets the same variant, raising the percentage keeps earlier users in, and different flags don't hit the same users first. Browsers and apps don't get rules; the API returns evaluated flags for that user, and the app caches them with safe defaults. Risky features roll out through a plan: one, five, twenty-five, fifty, a hundred percent, with guardrail metrics compared by variant and an automatic revert on a breach. If the flag service is down, pods keep the last snapshot. And release flags have owners and expiry dates, so they get removed.

## Follow-ups

**Q:** Then: someone jumped a flag from 5% to 100% and the database fell over. Prevention, and how fast is "off"?
**A:** Off is the flag change itself: setting it back propagates to all pods in ~1-2 s with no deploy, and the incident timeline shows exactly which change caused it because every change is audited. Prevention: flags tagged high-risk can only move through a rollout plan with a maximum step size and soak time, manual jumps need a second approver, and the DB-load guardrail reverts a step automatically. Plus a load test before the 25% step for anything that adds queries.

**Q:** How do you run A/B experiments on this?
**A:** Log the exposure when the user actually sees the feature, not when the flag is evaluated speculatively; check for sample ratio mismatch (a 50/50 split that arrives as 52/48 means broken assignment); decide the success metric before starting.

**Q:** How do you test code with dozens of flags?
**A:** Test each flag's default and its new variant, not every combination; integration tests force variants through SDK overrides; keeping flags few and short-lived is what keeps this tractable.

</details>

## Theory in the notes

- [08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md](../../08-devops-cloud/01-kubernetes-probes-and-deployment-strategies.md)
- [07-observability-reliability/01-sli-slo-error-budgets-alerting-runbooks.md](../../07-observability-reliability/01-sli-slo-error-budgets-alerting-runbooks.md)
- [06-distributed-systems/03-resilience-patterns.md](../../06-distributed-systems/03-resilience-patterns.md)
- [08-devops-cloud/04-testing-strategy.md](../../08-devops-cloud/04-testing-strategy.md)
