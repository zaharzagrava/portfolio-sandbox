#!/usr/bin/env node
// Track 12 fault-injection runner. Pauses ONE dependency container of the running dev stack while
// packages/web/tests/seller/cross-cutting/fault-injection.spec.ts does its actions, then unpauses it and lets the spec check the recovery.
//   node scripts/aiqa/tracks/fault-injection/run.mjs [--mark] postgres redis kafka elasticsearch minio scylla elasticmq clamav clickhouse
//   (no dependency = all of them, one after the other; "db" is accepted for "postgres")
//   --mark: after each run, write the result of every map line (scripts/aiqa/coverage/fault-injection.tsv) with scripts/aiqa/mark.mjs
// The spec skips itself unless this runner sets AIQA_FAULT=1, so the normal test suite never pauses a container.
// Safety: the pause window is announced in /tmp/fe/fault-window.txt, never longer than WINDOW_MS (4.5 minutes), and every container is
// unpaused again on exit, on Ctrl-C, on a crash, and when the spec writes "abort".
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';


const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const CONTAINERS = {
  db: 'payment_system_db', redis: 'payment_system_redis', kafka: 'payment_system_kafka', elasticsearch: 'payment_system_elasticsearch',
  minio: 'payment_system_minio', scylla: 'payment_system_scylla', elasticmq: 'payment_system_elasticmq', clamav: 'payment_system_clamav',
  clickhouse: 'payment_system_clickhouse', 'serverless-redis': 'payment_system_serverless_redis_http',
};
const WINDOW_FILE = process.env.FAULT_WINDOW_FILE ?? '/tmp/fe/fault-window.txt';
const WINDOW_MS = 270_000;
const BASE = '/tmp/fe/fault';

const docker = (...args) => { try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); } catch (e) { return `ERR ${String(e.stderr ?? e.message).trim()}`; } };
const isPaused = (name) => docker('inspect', '-f', '{{.State.Paused}}', name) === 'true';
function unpauseAll() {
  for (const name of Object.values(CONTAINERS)) if (isPaused(name)) { console.log(`unpausing ${name}: ${docker('unpause', name)}`); }
}
let cleaned = false;
function cleanup() { if (cleaned) return; cleaned = true; try { unpauseAll(); } catch { /* best effort */ } }
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanup(); process.exit(130); });
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(1); });

/** Reads Playwright's JSON report and marks each map line: every test annotated with it passed -> pass, one failed -> bug (bug id "spec-fail"). */
function markFromReport(file) {
  if (!existsSync(file)) { console.error(`no report at ${file}: nothing marked`); return; }
  const report = JSON.parse(readFileSync(file, 'utf8'));
  const lines = new Map();
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
      const ids = (test.annotations ?? []).filter((a) => a.type === 'aiqa-lines').flatMap((a) => (a.description ?? '').split(/[\s,]+/).filter(Boolean));
      const err = test.results?.at(-1)?.error?.message?.split('\n')[0] ?? '';
      for (const id of ids) {
        const r = lines.get(id) ?? { passed: 0, failed: 0, skipped: 0, why: '' };
        if (test.status === 'expected') r.passed++; else if (test.status === 'skipped') r.skipped++; else { r.failed++; r.why ||= `${spec.title}: ${err}`.slice(0, 200); }
        lines.set(id, r);
      }
    }
    (suite.suites ?? []).forEach(walk);
  };
  (report.suites ?? []).forEach(walk);
  for (const [id, r] of lines) {
    if (r.skipped && !r.failed) continue;
    const args = r.failed ? [id, 'bug', 'ui,api,db', 'spec-fail', `fault run: ${r.why}`] : [id, 'pass', 'ui,api,db', '-', `fault run ${new Date().toISOString().slice(0, 10)}: honest result during the outage, one clean retry, data consistent`];
    try { execFileSync('node', [path.join(root, 'scripts/aiqa/mark.mjs'), 'fault-injection', ...args], { stdio: 'inherit' }); } catch (e) { console.error(`could not mark ${id}: ${e.message}`); }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const MARK = args.includes('--mark');
const wanted = (args.filter((a) => !a.startsWith('--')).length ? args.filter((a) => !a.startsWith('--')) : Object.keys(CONTAINERS).filter((k) => k !== 'serverless-redis')).map((d) => (d === 'postgres' ? 'db' : d));
const summary = [];

for (const dep of wanted) {
  const container = CONTAINERS[dep];
  if (!container) { console.error(`unknown dependency "${dep}"; known: ${Object.keys(CONTAINERS).join(', ')}`); continue; }
  const dir = path.join(BASE, dep);
  rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
  const exists = (f) => existsSync(path.join(dir, f));
  const raise = (f) => writeFileSync(path.join(dir, f), String(Date.now()));
  console.log(`\n=== ${dep} (${container}) ===`);
  const log = path.join(dir, 'playwright.log');
  const child = spawn('npx', ['playwright', 'test', 'tests/seller/cross-cutting/fault-injection.spec.ts', '--project=desktop', '--workers=1', '--reporter=list,json'], {
    cwd: path.join(root, 'packages/web'), env: { ...process.env, AIQA_FAULT: '1', FAULT_DEP: dep, FAULT_DIR: dir, PW_EXPECT_TIMEOUT_MS: '10000', PLAYWRIGHT_JSON_OUTPUT_NAME: path.join(dir, 'report.json') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let exited = false; let out = '';
  child.stdout.on('data', (d) => { out += d; appendFileSync(log, d); }); child.stderr.on('data', (d) => { out += d; appendFileSync(log, d); });
  child.on('exit', () => { exited = true; });

  // wait for the spec's "ready" (set-up done while healthy), at most 5 minutes
  const readyBy = Date.now() + 300_000;
  while (!exists('ready') && !exited && Date.now() < readyBy) await sleep(500);
  let pausedAt = 0; let windowMs = 0;
  if (exists('ready') && !exited) {
    const start = new Date();
    writeFileSync(WINDOW_FILE, `FAULT WINDOW OPEN: ${dep} (${container}) paused from ${start.toISOString()} for at most ${WINDOW_MS / 1000}s. Run by the fault-injection agent; other testers: expect errors from ${dep}.\n`);
    console.log(`pause: ${docker('pause', container)}`);
    pausedAt = Date.now(); raise('paused');
    while (!exists('paused-done') && !exists('abort') && !exited && Date.now() - pausedAt < WINDOW_MS) await sleep(500);
    console.log(`unpause: ${docker('unpause', container)}`);
    windowMs = Date.now() - pausedAt; raise('resumed');
    writeFileSync(WINDOW_FILE, `FAULT WINDOW CLOSED: ${dep} (${container}) was paused ${new Date(pausedAt).toISOString()} .. ${new Date().toISOString()} (${Math.round(windowMs / 1000)}s). Nothing is paused now.\n`);
    if (isPaused(container)) console.error(`WARNING ${container} still paused, retrying: ${docker('unpause', container)}`);
  } else {
    console.error('the spec never became ready; see', log);
  }
  // the spec's recovery part: up to 8 minutes
  const doneBy = Date.now() + 480_000;
  while (!exited && Date.now() < doneBy) await sleep(1000);
  if (!exited) { child.kill('SIGTERM'); await sleep(3000); }
  unpauseAll();
  const passed = /\n\s+\d+ passed/.test(out) && !/\n\s+\d+ failed/.test(out);
  if (MARK) markFromReport(path.join(dir, 'report.json'));
  summary.push({ dep, windowSeconds: Math.round(windowMs / 1000), passed, log });
  console.log(`${dep}: window ${Math.round(windowMs / 1000)}s, spec ${passed ? 'PASSED' : 'FAILED (see log)'}`);
  // let the dependency settle before the next one
  await sleep(10_000);
}
try { writeFileSync(path.join(BASE, 'summary.json'), JSON.stringify(summary, null, 1)); } catch { /* ignore */ }
console.log('\nsummary:', JSON.stringify(summary));
cleanup();
