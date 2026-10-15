// e2e specs always run against docker-compose.test.yaml (D5); ApiConfigService
// loads `.env.test` when NODE_ENV=test (copy env/test.env.example).
process.env.NODE_ENV = 'test';
// The scripted model provider is never selected by a missing key (S46 AS-74): specs choose it explicitly.
process.env.LLM_PROVIDER ??= 'scripted';

// Expected failures (401/429 problem responses, retries) make Nest log whole stack traces and drown the signal in
// test output, which both humans and coding agents read. Keep fatal only; TEST_LOGS=1 restores the full output.
import { Logger } from '@nestjs/common';
if (!process.env.TEST_LOGS) Logger.overrideLogger(['fatal']);
