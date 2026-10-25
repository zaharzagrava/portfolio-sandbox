// Vitest reporter for QA track 14 (flaky history). Active only when TEST_HISTORY=1; otherwise it does nothing.
// Appends one JSON line per test to $TEST_HISTORY_OUT (default <repo>/specs/.checkpoints/test-history.jsonl), same shape as the
// Playwright one (packages/web/tests/support/history-reporter.ts):
//   { suite: 'vitest', run, name, file, project, result, duration, retries, commit, date }
// Use: TEST_HISTORY=1 pnpm --filter api exec vitest run --config vitest.e2e.config.ts --reporter=default --reporter=./test/history-reporter.ts <file>
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Reporter, TestCase } from 'vitest/node';

const ENABLED = process.env.TEST_HISTORY === '1';

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

export default class HistoryReporter implements Reporter {
  private repo = ENABLED ? git(['rev-parse', '--show-toplevel']) : '';
  private commit = ENABLED ? git(['rev-parse', '--short=10', 'HEAD']) : '';
  private run = new Date().toISOString();
  private out = process.env.TEST_HISTORY_OUT || path.join(this.repo && this.repo !== 'unknown' ? this.repo : process.cwd(), 'specs/.checkpoints/test-history.jsonl');

  onTestCaseResult(testCase: TestCase) {
    if (!ENABLED) return;
    const result = testCase.result();
    const diag = testCase.diagnostic();
    const line = {
      suite: 'vitest',
      run: this.run,
      name: testCase.fullName.slice(0, 200),
      file: testCase.module.moduleId.split('packages/backend/')[1] ?? testCase.module.moduleId,
      project: testCase.project.name || 'backend',
      result: result.state === 'failed' ? 'failed' : result.state === 'skipped' ? 'skipped' : 'passed',
      duration: Math.round(diag?.duration ?? 0),
      retries: diag?.retryCount ?? 0,
      commit: this.commit,
      date: new Date().toISOString(),
    };
    try {
      mkdirSync(path.dirname(this.out), { recursive: true });
      appendFileSync(this.out, JSON.stringify(line) + '\n');
    } catch {
      /* ignore */
    }
  }
}
