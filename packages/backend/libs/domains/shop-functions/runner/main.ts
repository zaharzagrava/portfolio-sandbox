import { createServer, type Server, type Socket } from 'node:net';
import { unlinkSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { FunctionSandbox } from '../infra/sandbox';
import type { VerdictRecord } from '../domain/contract';
import {
  MAX_REQUEST_BYTES,
  runnerRequestSchema,
  type RunnerReply,
  type RunnerRequestMessage,
} from './protocol';

const round = (ms: number) => Math.round(ms * 100) / 100;

/** Judges one request: one fresh isolate per case, destroyed after the case (the sandbox does it), in case order. */
export async function judgeRequest(
  sandbox: FunctionSandbox,
  request: RunnerRequestMessage,
): Promise<RunnerReply> {
  const started = performance.now();
  const verdicts: VerdictRecord[] = [];
  for (const testCase of request.cases) {
    if (performance.now() - started > request.totalBudgetMs)
      return { runId: request.runId, error: 'budget' };
    const res = await sandbox.run(
      request.source,
      testCase.input,
      request.caseBudgetMs,
    );
    if (res.ok)
      verdicts.push(
        isDeepStrictEqual(res.output, testCase.expected)
          ? { case: testCase.name, verdict: 'pass', ms: round(res.ms) }
          : {
              case: testCase.name,
              verdict: 'wrong-output',
              actual: res.output,
              ms: round(res.ms),
            },
      );
    else
      verdicts.push({
        case: testCase.name,
        verdict: res.error,
        detail: res.detail,
        ms: round(res.ms),
      });
  }
  return { runId: request.runId, verdicts };
}

export interface RunnerServer {
  server: Server;
  close(): Promise<void>;
}

/**
 * The function-runner program (S45 FR-024): a socket server over the sandbox and nothing else. It imports no database,
 * queue, cache or HTTP client, holds no credential, and answers only on the socket it listens on.
 */
export function startRunnerServer(
  socketPath: string,
  sandbox: FunctionSandbox = new FunctionSandbox(),
): Promise<RunnerServer> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    let buffer = '';
    let handled = false;
    socket.on('data', (chunk) => {
      if (handled) return;
      buffer += chunk.toString('utf8');
      if (buffer.length > MAX_REQUEST_BYTES) {
        handled = true;
        socket.destroy();
        return;
      }
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      handled = true;
      void reply(socket, buffer.slice(0, end), sandbox);
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    try {
      unlinkSync(socketPath);
    } catch {
      // no stale socket
    }
    server.listen(socketPath, () =>
      resolve({
        server,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}

async function reply(socket: Socket, line: string, sandbox: FunctionSandbox) {
  let message: RunnerReply;
  try {
    const parsed = runnerRequestSchema.safeParse(JSON.parse(line));
    if (!parsed.success) {
      socket.end();
      return;
    }
    message = await judgeRequest(sandbox, parsed.data);
  } catch {
    // The request is unreadable or the sandbox failed: say nothing the coordinator could mistake for a verdict.
    const runId = /"runId"\s*:\s*"([0-9a-f-]{36})"/i.exec(line)?.[1];
    message = runId
      ? { runId, error: 'internal' }
      : ({
          runId: '00000000-0000-0000-0000-000000000000',
          error: 'internal',
        } as RunnerReply);
  }
  socket.end(`${JSON.stringify(message)}\n`);
}
