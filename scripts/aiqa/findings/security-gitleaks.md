# Security: gitleaks (secrets in the code and its history)

Run 2026-10-25 07:34. Looks for passwords, keys and tokens in the whole git history and in the files of the working copy that git does not ignore.

Result: 77 flags.

- `packages/backend/env/test.env.example:31` rule generic-api-key (commit 5758120a): `INTEGRATION_CURSOR_KEY=test-integration-cursor-key-0123456789abcd`
- `packages/backend/libs/domains/assistant/domain/sensitive-data.spec.ts:66` rule private-key (commit 245a021d): `-----BEGIN RSA PRIVATE KEY-----'], ['pem ec', '-----BEGIN EC PRIVATE K`
- `packages/backend/env/test.env.example:22` rule generic-api-key (commit 1c054773): `API_KEY_PEPPER=test-api-key-pepper-0123456789abcdefghijkl`
- `packages/backend/libs/domains/developer-platform/public-api-auth.e2e-spec.ts:631` rule generic-api-key (commit 1c054773): `API_KEY_PEPPER: 'rotated-api-key-pepper-0123456789abcdefghijkl'`
- `packages/backend/libs/domains/experimentation/flags-client.e2e-spec.ts:17` rule generic-api-key (commit 947925cd): `EDGE_SECRET = 'test-flags-edge-secret-0123456789abcdef'`
- `packages/backend/libs/domains/assistant/domain/sensitive-data.spec.ts:13` rule private-key (commit 1915dd87): `-----BEGIN RSA PRIVATE KEY-----\nMIIE'], ['a generic private key heade`
- `packages/backend/env/test.env.example:20` rule generic-api-key (commit 506f3118): `ADS_CLICK_SECRET=test-ads-click-secret-0123456789abcdefghij`
- `docs/spec/terms/idempotency-key.md:17` rule generic-api-key (commit 94e88ab0): `Idempotency-Key: 7c1e9a42-5b3d-4f8e-a0c6-2d9f1b8e7a10 `
- `docs/spec/terms/payment-intent.md:17` rule generic-api-key (commit 94e88ab0): `Idempotency-Key: pay-7f3a9c21e4 `
- `packages/backend/libs/domains/notifications/notifications-catalog.e2e-spec.ts:170` rule generic-api-key (commit ff5de870): `token: 'Tok_en-1234567890'`
- `packages/backend/libs/domains/payments/reconciliation-issues.e2e-spec.ts:222` rule generic-api-key (commit 3aec9f4b): `Idempotency-Key', 'k-1234567890'`
- `packages/backend/libs/domains/payments/payment-ops.e2e-spec.ts:25` rule generic-api-key (commit 44c6fed5): `SENTINEL_SECRET = 'pi_SENTINEL_secret_41d2e8'`
- `packages/web/app/checkout/actions.test.ts:34` rule generic-api-key (commit f7aecc23): `KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b'`
- `packages/web/lib/api/checkout.test.ts:8` rule generic-api-key (commit f7aecc23): `KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b'`
- `packages/web/lib/server/checkout.server.test.ts:15` rule generic-api-key (commit f7aecc23): `KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b'`
- `packages/web/components/checkout/pay-panel.test.tsx:47` rule generic-api-key (commit f7aecc23): `SECRET = 'pi_3Abc_secret_ZYX987'`
- `specs/domains/S49-job-scheduler/plan.md:99` rule generic-api-key (commit 0df2e310): `cancelByKey, upsert/removeSchedule`
- `packages/backend/libs/infrastructure/projections/observability.e2e-spec.ts:48` rule generic-api-key (commit f5dceeca): `TOKEN = 'tok_live_51Habcdef'`
- `packages/backend/libs/infrastructure/http-client/resilient-http-client.e2e-spec.ts:181` rule generic-api-key (commit 5d87c638): `Idempotency-Key': 'key-12345678'`
- `docs/spec/terms/idempotency-key.md:17` rule generic-api-key (working copy): `Idempotency-Key: 7c1e9a42-5b3d-4f8e-a0c6-2d9f1b8e7a10 `
- `docs/spec/terms/payment-intent.md:17` rule generic-api-key (working copy): `Idempotency-Key: pay-7f3a9c21e4 `
- `packages/backend/env/test.env.example:22` rule generic-api-key (working copy): `ADS_CLICK_SECRET=test-ads-click-secret-0123456789abcdefghij`
- `packages/backend/env/test.env.example:24` rule generic-api-key (working copy): `API_KEY_PEPPER=test-api-key-pepper-0123456789abcdefghijkl`
- `packages/backend/env/test.env.example:31` rule generic-api-key (working copy): `INTEGRATION_CURSOR_KEY=test-integration-cursor-key-0123456789abcd`
- `packages/backend/libs/domains/assistant/domain/sensitive-data.spec.ts:14` rule private-key (working copy): `-----BEGIN RSA PRIVATE KEY-----\nMIIE'], ['a generic private key heade`
- `packages/backend/libs/domains/assistant/domain/sensitive-data.spec.ts:66` rule private-key (working copy): `-----BEGIN RSA PRIVATE KEY-----'], ['pem ec', '-----BEGIN EC PRIVATE K`
- `packages/backend/libs/domains/developer-platform/public-api-auth.e2e-spec.ts:631` rule generic-api-key (working copy): `API_KEY_PEPPER: 'rotated-api-key-pepper-0123456789abcdefghijkl'`
- `packages/backend/libs/domains/experimentation/flags-client.e2e-spec.ts:17` rule generic-api-key (working copy): `EDGE_SECRET = 'test-flags-edge-secret-0123456789abcdef'`
- `packages/backend/libs/domains/notifications/notifications-catalog.e2e-spec.ts:170` rule generic-api-key (working copy): `token: 'Tok_en-1234567890'`
- `packages/backend/libs/domains/payments/payment-ops.e2e-spec.ts:25` rule generic-api-key (working copy): `SENTINEL_SECRET = 'pi_SENTINEL_secret_41d2e8'`
- `packages/backend/libs/domains/payments/reconciliation-issues.e2e-spec.ts:226` rule generic-api-key (working copy): `Idempotency-Key', 'k-1234567890'`
- `packages/backend/libs/infrastructure/http-client/resilient-http-client.e2e-spec.ts:181` rule generic-api-key (working copy): `Idempotency-Key': 'key-12345678'`
- `packages/backend/libs/infrastructure/projections/observability.e2e-spec.ts:49` rule generic-api-key (working copy): `TOKEN = 'tok_live_51Habcdef'`
- `packages/web/aiqa-inv1-state.json:1` rule jwt (working copy): `eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCIsImtpZCI6IjNjYzE0Yjc1LWVmNzEtND`
- `packages/web/aiqa-inv1-state.json:1` rule jwt (working copy): `eyJhbGciOiJFUzI1NiIsInR5cCI6ImF0K2p3dCIsImtpZCI6IjNjYzE0Yjc1LWVmNzEtND`
- `packages/web/app/checkout/actions.test.ts:34` rule generic-api-key (working copy): `KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b'`
- `packages/web/components/checkout/pay-panel.test.tsx:47` rule generic-api-key (working copy): `SECRET = 'pi_3Abc_secret_ZYX987'`
- `packages/web/lib/api/checkout.test.ts:8` rule generic-api-key (working copy): `KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b'`
- `packages/web/lib/server/checkout.server.test.ts:15` rule generic-api-key (working copy): `KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b'`
- `scripts/aiqa/tracks/security/triage/gitleaks.md:4` rule generic-api-key (working copy): `secret, `tok_live_51Habcdef``
- `scripts/aiqa/findings/security-gitleaks.md:7` rule generic-api-key (working copy): `INTEGRATION_CURSOR_KEY=test-integration-cursor-key-0123456789abcd``
- `scripts/aiqa/findings/security-gitleaks.md:9` rule generic-api-key (working copy): `API_KEY_PEPPER=test-api-key-pepper-0123456789abcdefghijkl``
- `scripts/aiqa/findings/security-gitleaks.md:10` rule generic-api-key (working copy): `API_KEY_PEPPER: 'rotated-api-key-pepper-0123456789abcdefghijkl'`
- `scripts/aiqa/findings/security-gitleaks.md:11` rule generic-api-key (working copy): `EDGE_SECRET = 'test-flags-edge-secret-0123456789abcdef'`
- `scripts/aiqa/findings/security-gitleaks.md:13` rule generic-api-key (working copy): `ADS_CLICK_SECRET=test-ads-click-secret-0123456789abcdefghij``
- `scripts/aiqa/findings/security-gitleaks.md:14` rule generic-api-key (working copy): `Idempotency-Key: 7c1e9a42-5b3d-4f8e-a0c6-2d9f1b8e7a10 `
- `scripts/aiqa/findings/security-gitleaks.md:15` rule generic-api-key (working copy): `Idempotency-Key: pay-7f3a9c21e4 `
- `scripts/aiqa/findings/security-gitleaks.md:16` rule generic-api-key (working copy): `token: 'Tok_en-1234567890'`
- `scripts/aiqa/findings/security-gitleaks.md:17` rule generic-api-key (working copy): `Idempotency-Key', 'k-1234567890'`
- `scripts/aiqa/findings/security-gitleaks.md:18` rule generic-api-key (working copy): `SENTINEL_SECRET = 'pi_SENTINEL_secret_41d2e8'`
- `scripts/aiqa/findings/security-gitleaks.md:19` rule generic-api-key (working copy): `KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b'`
- `scripts/aiqa/findings/security-gitleaks.md:20` rule generic-api-key (working copy): `KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b'`
- `scripts/aiqa/findings/security-gitleaks.md:21` rule generic-api-key (working copy): `KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b'`
- `scripts/aiqa/findings/security-gitleaks.md:22` rule generic-api-key (working copy): `SECRET = 'pi_3Abc_secret_ZYX987'`
- `scripts/aiqa/findings/security-gitleaks.md:23` rule generic-api-key (working copy): `cancelByKey, upsert/removeSchedule``
- `scripts/aiqa/findings/security-gitleaks.md:24` rule generic-api-key (working copy): `TOKEN = 'tok_live_51Habcdef'`
- `scripts/aiqa/findings/security-gitleaks.md:25` rule generic-api-key (working copy): `Idempotency-Key': 'key-12345678'`
- `scripts/aiqa/findings/security-gitleaks.md:26` rule generic-api-key (working copy): `Idempotency-Key: 7c1e9a42-5b3d-4f8e-a0c6-2d9f1b8e7a10 `
- `scripts/aiqa/findings/security-gitleaks.md:27` rule generic-api-key (working copy): `Idempotency-Key: pay-7f3a9c21e4 `
- `scripts/aiqa/findings/security-gitleaks.md:28` rule generic-api-key (working copy): `ADS_CLICK_SECRET=test-ads-click-secret-0123456789abcdefghij``
- `scripts/aiqa/findings/security-gitleaks.md:29` rule generic-api-key (working copy): `API_KEY_PEPPER=test-api-key-pepper-0123456789abcdefghijkl``
- `scripts/aiqa/findings/security-gitleaks.md:30` rule generic-api-key (working copy): `INTEGRATION_CURSOR_KEY=test-integration-cursor-key-0123456789abcd``
- `scripts/aiqa/findings/security-gitleaks.md:33` rule generic-api-key (working copy): `API_KEY_PEPPER: 'rotated-api-key-pepper-0123456789abcdefghijkl'`
- `scripts/aiqa/findings/security-gitleaks.md:34` rule generic-api-key (working copy): `EDGE_SECRET = 'test-flags-edge-secret-0123456789abcdef'`
- `scripts/aiqa/findings/security-gitleaks.md:35` rule generic-api-key (working copy): `token: 'Tok_en-1234567890'`
- `scripts/aiqa/findings/security-gitleaks.md:36` rule generic-api-key (working copy): `SENTINEL_SECRET = 'pi_SENTINEL_secret_41d2e8'`
- `scripts/aiqa/findings/security-gitleaks.md:37` rule generic-api-key (working copy): `Idempotency-Key', 'k-1234567890'`
- `scripts/aiqa/findings/security-gitleaks.md:38` rule generic-api-key (working copy): `Idempotency-Key': 'key-12345678'`
- `scripts/aiqa/findings/security-gitleaks.md:39` rule generic-api-key (working copy): `TOKEN = 'tok_live_51Habcdef'`
- `scripts/aiqa/findings/security-gitleaks.md:42` rule generic-api-key (working copy): `KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b'`
- `scripts/aiqa/findings/security-gitleaks.md:43` rule generic-api-key (working copy): `SECRET = 'pi_3Abc_secret_ZYX987'`
- `scripts/aiqa/findings/security-gitleaks.md:44` rule generic-api-key (working copy): `KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b'`
- `scripts/aiqa/findings/security-gitleaks.md:45` rule generic-api-key (working copy): `KEY = '6f1d2c3b-4a59-4687-8a9b-0c1d2e3f4a5b'`
- `scripts/aiqa/findings/security-gitleaks.md:46` rule generic-api-key (working copy): `cancelByKey, upsert/removeSchedule``
- `scripts/aiqa/findings/security-gitleaks.md:8` rule private-key (working copy): `-----BEGIN RSA PRIVATE KEY-----'], ['pem ec', '-----BEGIN EC PRIVATE K`
- `scripts/aiqa/findings/security-gitleaks.md:31` rule private-key (working copy): `-----BEGIN RSA PRIVATE KEY-----\nMIIE'], ['a generic private key heade`
- `specs/domains/S49-job-scheduler/plan.md:99` rule generic-api-key (working copy): `cancelByKey, upsert/removeSchedule`

---

## Verdicts after reading the code (by hand)

Read every one of the flags (the same files appear twice when they are in the history and in the working copy). ALL FALSE ALARMS, nothing real:

- `packages/backend/env/test.env.example` (API_KEY_PEPPER, ADS_CLICK_SECRET, INTEGRATION_CURSOR_KEY): example values for the test setup, made of "test-" plus a counting string. Not used anywhere real.
- `*.spec.ts`, `*.e2e-spec.ts`, `*.test.ts(x)` (fake pepper, fake edge secret, `tok_live_51Habcdef`, `pi_..._secret_ZYX987`, keys like `k-1234567890`): fixtures that exist to be fake.
- `sensitive-data.spec.ts` "BEGIN RSA PRIVATE KEY": one-line strings in a test that checks the assistant refuses to repeat private keys; no key body follows.
- `docs/spec/terms/*.md`, `specs/.../plan.md`: an example `Idempotency-Key` header and a text "upsert/removeSchedule".
- The demo seed password `Demo-Seed-Pw-7491!` is a public development value, printed by the seed script on purpose.

No real secret in the code or in the history. Suggestion (not a bug): add a `.gitleaks.toml` allow-list for the paths above so the next run is silent.
