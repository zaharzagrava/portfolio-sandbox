// Playwright reporter for QA track 14 (flaky history). Active only when TEST_HISTORY=1; otherwise it does nothing, so a normal run is unchanged.
// Appends one JSON line per test attempt to $TEST_HISTORY_OUT (default <repo>/specs/.checkpoints/test-history.jsonl):
//   { suite: 'playwright', run, name, file, project, result, duration, retries, commit, date }
// result is passed | failed | timedOut | skipped | interrupted; `retries` is the retry number of this attempt (0 = first try).
// Add it for one run with:  TEST_HISTORY=1 pnpm exec playwright test --reporter=list,./tests/support/history-reporter.ts <spec>
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter';

const ENABLED = process.env.TEST_HISTORY === '1';

function git(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

export default class HistoryReporter implements Reporter {
  private root = process.cwd();
  private repo = process.cwd();
  private commit = 'unknown';
  private run = new Date().toISOString();
  private out = '';

  onBegin(config: FullConfig) {
    if (!ENABLED) return;
    this.root = config.rootDir;
    this.repo = git(['rev-parse', '--show-toplevel'], this.root);
    this.commit = git(['rev-parse', '--short=10', 'HEAD'], this.root);
    this.out = process.env.TEST_HISTORY_OUT || path.join(this.repo === 'unknown' ? process.cwd() : this.repo, 'specs/.checkpoints/test-history.jsonl');
  }

  onTestEnd(test: TestCase, result: TestResult) {
    if (!ENABLED || !this.out) return;
    const line = {
      suite: 'playwright',
      run: this.run,
      name: test.titlePath().slice(2).join(' > ').slice(0, 200),
      file: path.relative(this.root, test.location.file),
      project: test.parent.project()?.name ?? '?',
      result: result.status,
      duration: result.duration,
      retries: result.retry,
      commit: this.commit,
      date: new Date().toISOString(),
    };
    try {
      mkdirSync(path.dirname(this.out), { recursive: true });
      appendFileSync(this.out, JSON.stringify(line) + '\n');
    } catch {
      /* a history line never fails a test */
    }
  }
}
