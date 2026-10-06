import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_CONFIG } from '../src/config.ts';
import { extractFile, stripComments } from '../src/extract.ts';

const cfg = DEFAULT_CONFIG;

test('stripComments blanks comments but keeps strings and line numbers', () => {
  const src = "const a = '// not a comment'; // real\n/* multi\nline */ const b = 1;";
  const out = stripComments(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.ok(out.includes("'// not a comment'"));
  assert.ok(!out.includes('real'));
  assert.ok(out.includes('const b = 1;'));
});

test('imports, re-exports and dynamic imports are found; commented ones are not', () => {
  const f = extractFile(
    'a.ts',
    ["import { x } from './x';", "import type { T } from './t';", "export * from './barrel';", "// import { no } from './no';", "const m = await import('./lazy');"].join('\n'),
    cfg,
  );
  assert.deepEqual(
    f.imports.map((i) => [i.spec, i.kind, i.typeOnly]),
    [['./x', 'import', false], ['./t', 'import', true], ['./barrel', 'reexport', false], ['./lazy', 'dynamic', false]],
  );
});

test('exports carry kind and line', () => {
  const f = extractFile('a.ts', 'export const A = 1;\n\nexport async function run() {}\nexport class Svc {}\nexport { A as B };', cfg);
  assert.deepEqual(f.exports.map((e) => [e.name, e.kind, e.line]), [['A', 'const', 1], ['run', 'function', 3], ['Svc', 'class', 4], ['B', 'reexport', 5]]);
});

test('Nest controller routes are joined with their prefix', () => {
  const f = extractFile(
    'c.controller.ts',
    [
      "@Controller('shops/:id')",
      'export class C {',
      "  @Get('balance')",
      "  @UseGuards(AuthGuard('jwt'))",
      '  async balance() {}',
      '  @Post()',
      '  create() {}',
      '}',
    ].join('\n'),
    cfg,
  );
  assert.deepEqual(f.routes.map((r) => `${r.method} ${r.path} ${r.handler}`), ['GET /shops/:id/balance balance', 'POST /shops/:id create']);
});

test('events, jobs and schedules follow the configured conventions', () => {
  const f = extractFile(
    'e.ts',
    [
      "export const Paid = defineEvent('order.paid', 'orders', 1, z.object({}));",
      'await this.domainEvents.record(Paid.create(id, 1, {}));',
      'const e = Paid.match(raw);',
      "@JobHandler('payouts.send', { concurrency: 2 })",
      'async send() {}',
      "await this.jobs.enqueue('payouts.send', { id });",
      "await this.jobs.upsertSchedule({ name: 'n', cron: '0 6 * * 1', jobType: 'payouts.run' });",
      "// this.jobs.enqueue('in.a.comment', {})",
    ].join('\n'),
    cfg,
  );
  assert.deepEqual(f.eventDefs.map((e) => [e.const, e.name, e.aggregate]), [['Paid', 'order.paid', 'orders']]);
  assert.deepEqual(f.createCalls, ['Paid']);
  assert.deepEqual(f.matchCalls, ['Paid']);
  assert.deepEqual(f.jobHandlers.map((j) => [j.name, j.handler]), [['payouts.send', 'send']]);
  assert.deepEqual(f.jobsEnqueued, ['payouts.send']);
  assert.deepEqual(f.schedules, [{ job: 'payouts.run', cron: '0 6 * * 1' }]);
});

test('barrels and tiny files are trivial; real code is not', () => {
  assert.equal(extractFile('i.ts', "export * from './a';\nexport { B } from './b';\n", cfg).isBarrel, true);
  assert.equal(extractFile('k.ts', "export const K = 'x';\n", cfg).isTrivial, true);
  const big = extractFile('s.ts', `${Array.from({ length: 12 }, (_, i) => `export const v${i} = ${i};`).join('\n')}\nexport * from './a';\n`, cfg);
  assert.equal(big.isBarrel, false);
  assert.equal(big.isTrivial, false);
});

test('rust and go exports are picked up', () => {
  assert.deepEqual(extractFile('l.rs', 'pub struct Book {}\nfn private() {}\npub async fn run() {}', cfg).exports.map((e) => e.name), ['Book', 'run']);
  assert.deepEqual(extractFile('m.go', 'func Public() {}\nfunc private() {}\ntype Server struct{}', cfg).exports.map((e) => e.name), ['Public', 'Server']);
});
