import { resolve } from 'node:path';
import { SQSClient } from '@aws-sdk/client-sqs';
import {
  redrive,
  RunnerStartupError,
  startRunner,
} from '@app/infrastructure/serverless/runner';

/**
 * Local stand-in for the Lambda service + SQS event source mapping (D19): a launcher around the runner engine in
 * `libs/infrastructure/serverless/runner`. It starts the BUILT functions from `dist/lambda-bundles/manifest.json`
 * (run `pnpm build:lambdas` first), so what runs locally is what is deployed.
 *
 *   pnpm start:lambda-local [name...]               start the named functions (default: all)
 *   pnpm start:lambda-local --redrive <dlq-name>    move every message of a dead-letter queue back to its source
 *
 * Environment: SQS_ENDPOINT (default local ElasticMQ), SQS_QUEUE_URL_PREFIX, LAMBDA_LOCAL_MAX_CONCURRENCY (default 2),
 * LAMBDA_BUNDLES_DIR (default dist/lambda-bundles).
 */
const endpoint = process.env.SQS_ENDPOINT ?? 'http://localhost:9324';
const sqs = new SQSClient({
  region: 'eu-central-1',
  endpoint,
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const redriveAt = args.indexOf('--redrive');
  if (redriveAt >= 0) {
    const dlq = args[redriveAt + 1];
    if (!dlq) {
      console.error('usage: --redrive <dead-letter-queue-name>');
      return 2;
    }
    const moved = await redrive({ dlq, sqs });
    console.log(`redrive: moved ${moved} message(s) from ${dlq}`);
    return 0;
  }

  const handle = await startRunner({
    manifestPath: resolve(
      process.env.LAMBDA_BUNDLES_DIR ?? 'dist/lambda-bundles',
      'manifest.json',
    ),
    sqs,
    queueUrlPrefix:
      process.env.SQS_QUEUE_URL_PREFIX ?? `${endpoint}/000000000000/`,
    maxConcurrency: Number(process.env.LAMBDA_LOCAL_MAX_CONCURRENCY ?? 2),
    only: args,
  });
  let stopping: Promise<void> | undefined;
  const stop = () => (stopping ??= handle.stop());
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
  await handle.finished;
  await stop();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof RunnerStartupError ? error.message : error);
    process.exit(1);
  },
);
