// e2e specs always run against docker-compose.test.yaml (D5); ApiConfigService
// loads `.env.test` when NODE_ENV=test (copy env/test.env.example).
process.env.NODE_ENV = 'test';
