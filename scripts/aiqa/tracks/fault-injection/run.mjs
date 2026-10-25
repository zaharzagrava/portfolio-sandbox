#!/usr/bin/env node
// Track 12 fault-injection runner. Pauses ONE dependency container of the running dev stack while
// packages/web/tests/seller-fault-injection.spec.ts does its actions, then unpauses it and lets the spec check the recovery.
//   node scripts/aiqa/tracks/fault-injection/run.mjs db redis kafka elasticsearch minio scylla elasticmq clamav clickhouse
//   (no argument = all of them, one after the other)
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CONTAINERS).filter((k) => k !== 'serverless-redis');
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
  const child = spawn('npx', ['playwright', 'test', 'tests/seller-fault-injection.spec.ts', '--project=desktop', '--workers=1', '--reporter=list'], {
    cwd: path.join(root, 'packages/web'), env: { ...process.env, FAULT_DEP: dep, FAULT_DIR: dir, PW_EXPECT_TIMEOUT_MS: '10000' }, stdio: ['ignore', 'pipe', 'pipe'],
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
  summary.push({ dep, windowSeconds: Math.round(windowMs / 1000), passed, log });
  console.log(`${dep}: window ${Math.round(windowMs / 1000)}s, spec ${passed ? 'PASSED' : 'FAILED (see log)'}`);
  // let the dependency settle before the next one
  await sleep(10_000);
}
try { writeFileSync(path.join(BASE, 'summary.json'), JSON.stringify(summary, null, 1)); } catch { /* ignore */ }
console.log('\nsummary:', JSON.stringify(summary));
cleanup();
