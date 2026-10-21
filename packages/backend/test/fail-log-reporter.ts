// Vitest reporter: appends one line per failed test, the moment it fails, to $FAIL_LOG (default fail-log.txt):
//   <file> | <test name> | <first line of the error>
// so a run that is stopped early still shows what failed and why (the default reporter prints details only at the end).
import { appendFileSync } from 'node:fs';
import type { Reporter, TestCase, TestModule } from 'vitest/node';

export default class FailLogReporter implements Reporter {
  private out = process.env.FAIL_LOG || 'fail-log.txt';

  onTestCaseResult(testCase: TestCase) {
    const result = testCase.result();
    if (result.state !== 'failed') return;
    const first = (result.errors?.[0]?.message ?? '').split('\n')[0].replace(/\x1b\[[0-9;]*m/g, '').slice(0, 220);
    const file = testCase.module.moduleId.split('packages/backend/')[1] ?? testCase.module.moduleId;
    try {
      appendFileSync(this.out, `${file} | ${testCase.fullName.slice(-110)} | ${first}\n`);
    } catch {
      /* never fail a run for a log line */
    }
  }

  onTestModuleEnd(module: TestModule) {
    const state = module.state();
    if (state !== 'failed') return;
    // a file that failed before any test ran (import error)
    if ([...module.children.allTests()].length === 0) {
      const err = module.errors()[0]?.message?.split('\n')[0] ?? 'suite failed to start';
      try {
        appendFileSync(this.out, `${module.moduleId.split('packages/backend/')[1] ?? module.moduleId} | (suite) | ${err.slice(0, 220)}\n`);
      } catch {
        /* ignore */
      }
    }
  }
}
