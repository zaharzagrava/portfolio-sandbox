import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { connect } from 'node:net';
import { RequestContext } from '@app/infrastructure/context';
import type { VerdictRecord } from '../domain/contract';
import type { FunctionRunner, RunnerRequest } from '../domain/ports';
import { runnerReplySchema } from '../runner/protocol';

export const RUNNER_SOCKET_PATH = Symbol('SHOP_FUNCTIONS_RUNNER_SOCKET_PATH');
export const DEFAULT_RUNNER_SOCKET = '/run/function-runner/runner.sock';
/** Margin on top of the version budget before a silent runner counts as unavailable. */
const GRACE_MS = 2_000;

/**
 * The coordinator's side of the runner protocol (S45 FR-024): one connection per version over a Unix domain socket,
 * a connect and a total deadline (version budget + 2 s), a strict reply schema and a `runId` check. A missing, late or
 * invalid reply is "judge unavailable" (`null`): the version stays `TESTING` and recovery asks again (IV.6, IV.8).
 */
@Injectable()
export class RunnerClient implements FunctionRunner {
  private readonly logger = new Logger(RunnerClient.name);

  constructor(
    @Inject(RUNNER_SOCKET_PATH) private readonly socketPath: string,
    @Optional() private readonly context?: RequestContext,
  ) {}

  run(request: RunnerRequest): Promise<VerdictRecord[] | null> {
    return new Promise((resolve) => {
      let settled = false;
      let buffer = '';
      const socket = connect(this.socketPath);
      const finish = (verdicts: VerdictRecord[] | null, why?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (!verdicts && why)
          this.logger.warn(
            JSON.stringify({
              event: 'runner_unavailable',
              requestId: this.context?.requestId,
              traceId: this.context?.snapshot().traceparent?.split('-')[1],
              why,
            }),
          );
        resolve(verdicts);
      };
      const timer = setTimeout(
        () => finish(null, 'deadline'),
        request.totalBudgetMs + GRACE_MS,
      );
      socket.once('connect', () =>
        socket.write(`${JSON.stringify(request)}\n`),
      );
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        try {
          const parsed = runnerReplySchema.safeParse(
            JSON.parse(buffer.slice(0, end)),
          );
          if (!parsed.success) return finish(null, 'invalid_reply');
          if (parsed.data.runId !== request.runId)
            return finish(null, 'run_id_mismatch');
          if ('error' in parsed.data) return finish(null, parsed.data.error);
          finish(parsed.data.verdicts);
        } catch {
          finish(null, 'invalid_reply');
        }
      });
      socket.once('error', (error: NodeJS.ErrnoException) =>
        finish(null, error.code ?? 'socket_error'),
      );
      socket.once('close', () => finish(null, 'closed'));
    });
  }
}
