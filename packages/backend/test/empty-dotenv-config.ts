// Stands in for `dotenv/config` under the e2e Vitest run. Scripts that the specs import (scripts/chat/chat-s24-backfill.ts ...)
// start with `import 'dotenv/config'`, which copies the developer's backend/.env (PROVIDER_DOUBLES=enabled, local ports ...) into
// process.env. With one process for all files that leaked into every later file (the payment suites then got the scripted provider).
// The e2e environment is .env.test, loaded by ApiConfigService, so nothing is lost by making this import a no-op.
export {};
