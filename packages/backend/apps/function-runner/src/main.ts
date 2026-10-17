import { startRunnerServer } from '@app/domains/shop-functions';

/**
 * The function-runner (S45 FR-024): a program with no HTTP port, no database, queue or cache, started in a container
 * without network (infra/docker/function-runner/compose.yml). It listens on a Unix socket and answers only the judge
 * coordinator, which shares that socket's volume.
 */
const socketPath =
  process.env.FUNCTION_RUNNER_SOCKET ?? '/run/function-runner/runner.sock';

async function main() {
  const runner = await startRunnerServer(socketPath);
  process.stdout.write(
    `${JSON.stringify({ event: 'function_runner_listening', socket: socketPath })}\n`,
  );
  const stop = () => void runner.close().then(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

main().catch((error: Error) => {
  process.stderr.write(
    `${JSON.stringify({ event: 'function_runner_failed', error: error.name })}\n`,
  );
  process.exit(1);
});
