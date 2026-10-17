# Quickstart: validating S55

Run backend commands from `packages/backend`. Use `/opt/sdd/repo/scripts/sdd/test-spec.sh <path-or-pattern>` for e2e specs.

## Prerequisites

Test stack from `docker-compose.test.yaml` (DynamoDB local, ElasticMQ, Postgres 18). After editing `infra/docker/elasticmq/elasticmq.conf`, reload the queue server: `docker compose -p marketplace_test -f docker-compose.test.yaml restart test_elasticmq` (L-020; the service is `test_elasticmq`).

## Static checks

- `npx tsc --noEmit`, ESLint, `pnpm check:boundaries`, `pnpm check:table-ownership --strict` (record the `apps/lambdas` lines for G-07).
- `python3 scripts/livespec/check.py` after editing `docs/spec/capabilities/S55-serverless-workers.md`.

## Scenarios

| Area | Command (narrowest first) |
|---|---|
| Batch AS-01 to AS-12 | `test-spec.sh libs/infrastructure/serverless/batch` |
| Idempotency AS-13 to AS-25 | `test-spec.sh libs/infrastructure/serverless/idempotency` |
| Manifest and conformance AS-28 to AS-30, AS-37 | `test-spec.sh libs/infrastructure/serverless/manifest` |
| Runner AS-31 to AS-45, AS-50 | `test-spec.sh libs/infrastructure/serverless/runner` |
| Context AS-46, AS-47 | `test-spec.sh libs/infrastructure/serverless/context` |
| Telemetry AS-51 | `test-spec.sh libs/infrastructure/serverless/telemetry` |
| Bundles AS-48, AS-49, AS-52 | `pnpm build:lambdas` then `test-spec.sh libs/infrastructure/serverless/bundling` |
| Wiring AS-26, AS-27, AS-34, AS-35 | `test-spec.sh libs/infrastructure/serverless/workers-wiring` |

Run the whole `libs/infrastructure/serverless` suite once at the end.

## Ops artifacts

Success criteria no automated test proves (also rows in `specs/UNVERIFIED.md`, status "not run"):

- **SC-003**: the dead-letter depth alarm and `DeadLettered` metric reach an operator before anyone looks. Tests prove the Terraform has the alarm and the metric is emitted; delivery to the pager needs a deployed stack. Run: in demo, send a poison message to `onboarding-documents` and confirm the page.
- **SC-007**: local runner and the AWS Lambda service give the same record shape, deletions and retry counts. Tests prove the local side against the spec; the platform side needs a deployed function. Run: send the AS-38/AS-39 messages to a deployed demo queue and compare the logged event with the local one.
- **SC-008**: a new function is built, run, bounded and alarmed from one manifest entry plus one entry file with no other file edited. Tests prove the manifest, build and runner side; the alarm and mapping need `terraform plan`. Run: add a sample entry and read the plan.

Also not proven by a test (packaging, no success criterion of its own, listed so nobody assumes it): `sharp` is external in the `media-processing` bundle and must reach the deployed function as a Lambda layer (arm64) or `node_modules` next to `index.js`; the Nest bundles stub the native addons `argon2`, `bcrypt` and `isolated-vm`. Both need a deployed function to confirm.
