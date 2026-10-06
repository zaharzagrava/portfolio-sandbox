# <AlertName>

**Severity:** page | ticket · **Owner:** <team> · **Dashboards:** <links> · **SLO:** <name or n/a>

## What it means
One paragraph: what is broken for users, and how fast it gets worse.

## Triage (≤ 5 min)
1. Is it real? (dashboard panel / query that confirms it)
2. What changed? (deploys in the last hour: `gh run list --workflow deploy.yml`, feature flags, traffic spike)
3. Blast radius: which journeys, which shops/regions.

## Mitigate (stop the bleeding first, root-cause later)
- **If <cause A>:** <action> - command / console path.
- **If <cause B>:** <action>.
- **If a recent deploy:** roll back (`deploy.yml` → "rollback", or CodeDeploy "Stop and roll back").

## Verify
The query/panel that must return to normal, and for how long before you resolve.

## Follow-up
Ticket for the root cause; postmortem if SEV1/2 or > 20% of an error budget.
