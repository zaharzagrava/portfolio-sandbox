// Jest test environment that times each test file by phase, using Jest's own events (no wrapping of globals, so `it.each`, `describe` hooks and
// helpers are all counted). A plain node environment unless TEST_TIMING is set; with TEST_TIMING=1 it appends one JSON line per file to
// $TEST_TIMING_OUT (default: test-timing.jsonl in the working directory):
//   { file, total, load, beforeAll:{ms,n}, beforeEach:{ms,n}, afterEach:{ms,n}, afterAll:{ms,n}, tests:{ms,n}, other, slowTests:[{name,ms}], slowHooks:[{type,ms}] }
// load  = from the environment being created to the first test being collected (compiling and evaluating the file and everything it imports)
// other = what is left (jest's own overhead, teardown, the time between phases)
// Read it with scripts/sdd/timing-report.py.
const { TestEnvironment } = require('jest-environment-node');
const { appendFileSync } = require('node:fs');
const path = require('node:path');

class TimingEnvironment extends TestEnvironment {
  constructor(config, context) {
    super(config, context);
    this.timing = process.env.TEST_TIMING === '1' || process.env.TEST_TIMING === 'true';
    if (!this.timing) return;
    this.file = path.relative(config.globalConfig.rootDir || process.cwd(), context.testPath);
    this.t0 = Date.now();
    this.tRun = null;
    this.acc = { beforeAll: [0, 0], beforeEach: [0, 0], afterEach: [0, 0], afterAll: [0, 0], tests: [0, 0] };
    this.slowTests = [];
    this.slowHooks = [];
    this.openHook = null;
    this.openTest = null;
  }

  async handleTestEvent(event) {
    if (!this.timing) return;
    const now = Date.now();
    switch (event.name) {
      case 'run_start':
        this.tRun = now;
        break;
      case 'hook_start':
        this.openHook = { type: event.hook.type, at: now };
        break;
      case 'hook_success':
      case 'hook_failure': {
        if (this.openHook) {
          const ms = now - this.openHook.at;
          const slot = this.acc[this.openHook.type];
          if (slot) { slot[0] += ms; slot[1] += 1; }
          this.slowHooks.push({ type: this.openHook.type, ms });
          this.openHook = null;
        }
        break;
      }
      case 'test_fn_start':
        this.openTest = { name: event.test.name, at: now };
        break;
      case 'test_fn_success':
      case 'test_fn_failure': {
        if (this.openTest) {
          const ms = now - this.openTest.at;
          this.acc.tests[0] += ms; this.acc.tests[1] += 1;
          this.slowTests.push({ name: this.openTest.name, ms });
          this.openTest = null;
        }
        break;
      }
      case 'run_finish':
        this.report(now);
        break;
      default:
    }
  }

  report(now) {
    if (this.reported) return;
    this.reported = true;
    const total = now - this.t0;
    const load = (this.tRun ?? now) - this.t0;
    const used = Object.values(this.acc).reduce((s, [ms]) => s + ms, 0);
    const top = (list, key, n) => list.sort((a, b) => b.ms - a.ms).slice(0, n);
    const line = {
      file: this.file, total, load,
      beforeAll: { ms: this.acc.beforeAll[0], n: this.acc.beforeAll[1] },
      beforeEach: { ms: this.acc.beforeEach[0], n: this.acc.beforeEach[1] },
      afterEach: { ms: this.acc.afterEach[0], n: this.acc.afterEach[1] },
      afterAll: { ms: this.acc.afterAll[0], n: this.acc.afterAll[1] },
      tests: { ms: this.acc.tests[0], n: this.acc.tests[1] },
      other: Math.max(0, total - load - used),
      slowTests: top(this.slowTests, 'ms', 3),
      slowHooks: top(this.slowHooks, 'ms', 2),
    };
    try { appendFileSync(process.env.TEST_TIMING_OUT || 'test-timing.jsonl', JSON.stringify(line) + '\n'); } catch { /* never fail a test for a report */ }
  }
}

module.exports = TimingEnvironment;
