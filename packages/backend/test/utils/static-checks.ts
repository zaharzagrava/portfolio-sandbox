import { execFile } from 'node:child_process';

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command and shares the answer with every spec of this test process that asks for the same key (the module-boundary
 * check walks the whole backend and many specs ask for it). The sources do not change while the suite runs.
 * Answers are kept on `globalThis`, so they are shared by every file that runs in one process.
 */
export const runOnce = (
  key: string,
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<CommandResult> => {
  const store = globalThis as unknown as {
    __commandRuns?: Map<string, Promise<CommandResult>>;
  };
  store.__commandRuns ??= new Map();
  let run = store.__commandRuns.get(key);
  if (!run) {
    run = new Promise<CommandResult>((resolvePromise) =>
      execFile(
        command,
        args,
        {
          cwd,
          encoding: 'utf8',
          maxBuffer: 10_000_000,
          timeout,
          env: { ...process.env, FORCE_COLOR: '0', ...extraEnv },
        },
        (error, stdout, stderr) =>
          resolvePromise({
            status: error
              ? typeof error.code === 'number'
                ? error.code
                : 1
              : 0,
            stdout,
            stderr,
          }),
      ),
    );
    store.__commandRuns.set(key, run);
  }
  return run;
};

/** The whole-backend architecture scan (`pnpm check:boundaries`), run once per test process. Same key everywhere. */
export const boundaryCheck = (backendDir: string): Promise<CommandResult> =>
  runOnce(
    'check:boundaries',
    'pnpm',
    ['--silent', 'check:boundaries'],
    backendDir,
    280_000,
  );

/**
 * The table-ownership check, run once per test process for each flavour (extra arguments, and with or without the pnpm
 * banner line on top of the output; a spec that cares about the banner passes `banner: true`).
 */
export const ownershipCheck = (
  backendDir: string,
  extraArgs: string[] = [],
  banner = false,
): Promise<CommandResult> =>
  runOnce(
    `check:table-ownership:${extraArgs.join(' ') || 'plain'}:${banner ? 'with-banner' : 'silent'}`,
    'pnpm',
    [...(banner ? [] : ['--silent']), 'check:table-ownership', ...extraArgs],
    backendDir,
    280_000,
  );
