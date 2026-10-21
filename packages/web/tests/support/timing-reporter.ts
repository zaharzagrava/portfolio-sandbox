// Playwright reporter that records where each test spends its time. Active only when added to the reporter list (the checkpoint and the SDD
// gate add it when TEST_TIMING=1). Appends one JSON line per test attempt to $TEST_TIMING_OUT (default test-timing.jsonl):
//   { project, file, title, ms, status, retry, steps: { <category>: ms }, slowSteps: [{ title, category, ms }] }
// steps = the time of the top-level steps by category (hook, fixture, pw:api, expect, test.step); the rest of `ms` is the test body itself.
// Read it with scripts/sdd/timing-report.py.
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import type { FullConfig, Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter';

export default class TimingReporter implements Reporter {
  private root = process.cwd();
  private out = process.env.TEST_TIMING_OUT || 'test-timing.jsonl';

  onBegin(config: FullConfig) {
    this.root = config.rootDir;
  }

  onTestEnd(test: TestCase, result: TestResult) {
    const steps: Record<string, number> = {};
    const slow: { title: string; category: string; ms: number }[] = [];
    const walk = (list: TestStep[], top: boolean) => {
      for (const step of list) {
        if (top) steps[step.category] = (steps[step.category] ?? 0) + step.duration;
        slow.push({ title: step.title.slice(0, 80), category: step.category, ms: step.duration });
        walk(step.steps, false);
      }
    };
    walk(result.steps, true);
    slow.sort((a, b) => b.ms - a.ms);
    const line = {
      project: test.parent.project()?.name ?? '?',
      file: path.relative(this.root, test.location.file),
      title: test.title.slice(0, 120),
      ms: result.duration,
      status: result.status,
      retry: result.retry,
      steps,
      slowSteps: slow.slice(0, 3),
    };
    try {
      appendFileSync(this.out, JSON.stringify(line) + '\n');
    } catch {
      /* a report never fails a test */
    }
  }
}
