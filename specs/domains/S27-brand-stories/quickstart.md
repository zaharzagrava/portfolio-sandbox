# Quickstart: validating S27

Run from `packages/backend`. Use `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern>` for e2e; narrowest first, whole suite once at the end.

## Prerequisites

Test stack up (Postgres with migrations, Redis, Kafka stand-in, ElasticMQ). Nothing else is needed; the CDN and the revalidation endpoint are recording fakes.

## Scenarios (one file per user story, see [test-plan.md](test-plan.md))

| Story | Command |
|---|---|
| Drafts | `scripts/sdd/test-spec.sh libs/domains/content/story-drafts.e2e-spec.ts` |
| Publish | `… story-publish.e2e-spec.ts` |
| Public read | `… story-public-read.e2e-spec.ts` |
| Schedule | `… story-schedule.e2e-spec.ts` |
| Invalidation | `… story-revalidation.e2e-spec.ts` |
| Preview | `… story-preview.e2e-spec.ts` |
| Sitemap | `… story-sitemap.e2e-spec.ts` |
| Lifecycle | `… story-lifecycle.e2e-spec.ts` |
| Tenancy and ops | `… story-tenancy.e2e-spec.ts` |
| Unit | `pnpm jest libs/domains/content/domain` |
| Whole capability (once, at the end) | `scripts/sdd/test-spec.sh libs/domains/content` |

Static gates: `pnpm tsc --noEmit`, lint, `pnpm check:boundaries`, `pnpm --dir packages/backend check:table-ownership --strict` (no `content` line), `pnpm check:module-graph`, `pnpm check:model-registry`, `python3 scripts/livespec/check.py`.

Contracts reference: [contracts/interfaces.md](contracts/interfaces.md); tables: [data-model.md](data-model.md).

## Ops artifacts (not proven by an automated test; status "not run")

- **SC-003** — at least 99% of views answered by the CDN and origin 2,000 rps with p99 < 50 ms from the read model. How: `pnpm loadtest:stories` (`scripts/load-tests/stories.test.js`, origin-miss scenario) on the runner; the CDN hit ratio needs a real CDN and is read from its dashboard.
- **SC-001 (CDN and front-end part)** — visibility within 60 s through a real CDN and Next.js route cache. How: publish on a deployed stack, poll the public URL through the CDN; the origin, purge order and signed call are proven by `story-revalidation.e2e-spec.ts`.
- **Web half** — the story pages, `/api/revalidate` receiver and the editor UI have no owning capability; no UI journey exists.

Rows are recorded in `specs/UNVERIFIED.md`.
