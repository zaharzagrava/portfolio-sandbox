Read every one of the flags (the same files appear twice when they are in the history and in the working copy). ALL FALSE ALARMS, nothing real:

- `packages/backend/env/test.env.example` (API_KEY_PEPPER, ADS_CLICK_SECRET, INTEGRATION_CURSOR_KEY): example values for the test setup, made of "test-" plus a counting string. Not used anywhere real.
- `*.spec.ts`, `*.e2e-spec.ts`, `*.test.ts(x)` (fake pepper, fake edge secret, `tok_live_51Habcdef`, `pi_..._secret_ZYX987`, keys like `k-1234567890`): fixtures that exist to be fake.
- `sensitive-data.spec.ts` "BEGIN RSA PRIVATE KEY": one-line strings in a test that checks the assistant refuses to repeat private keys; no key body follows.
- `docs/spec/terms/*.md`, `specs/.../plan.md`: an example `Idempotency-Key` header and a text "upsert/removeSchedule".
- The demo seed password `Demo-Seed-Pw-7491!` is a public development value, printed by the seed script on purpose.

No real secret in the code or in the history. Suggestion (not a bug): add a `.gitleaks.toml` allow-list for the paths above so the next run is silent.
