import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Cache } from '../src/cache.ts';
import { DEFAULT_CONFIG, type DocsConfig } from '../src/config.ts';
import { listSourceFiles, readText } from '../src/files.ts';
import { buildGraph } from '../src/graph.ts';
import { extractJson, MockProvider, type LlmRequest, type LlmResponse, type Provider } from '../src/llm.ts';
import { buildConceptModel } from '../src/concepts.ts';
import { buildNodes } from '../src/nodes.ts';
import { Prose } from '../src/prose.ts';
import { noteLink, parseSections, renderNote, stripBlocks, theoryRefs, type Note } from '../src/theory.ts';
import { runPipeline } from '../src/pipeline.ts';
import { renderAll, syncOutputs } from '../src/render.ts';

const cfg: DocsConfig = { ...DEFAULT_CONFIG, units: [{ match: 'libs/*', group: 'domain' }, { match: 'apps/*', group: 'app' }], outDir: 'out' };

// Real code lines (comments are stripped), so the fixture files are not treated as trivial.
const PAD = Array.from({ length: 6 }, (_, i) => `const pad${i} = ${i};\n`).join('');

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'docs-fixture-'));
  const w = (p: string, body: string) => (mkdirSync(join(root, p, '..'), { recursive: true }), writeFileSync(join(root, p), body));
  w('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@app/*': ['libs/*'] } } }));
  w('libs/orders/order.service.ts', "import { Paid } from './events';\nimport { Mailer } from '@app/notify/mailer';\nexport class OrderService {\n  pay() { this.events.record(Paid.create('1', 1, {})); }\n  run() { new Mailer(); }\n}\n" + PAD);
  w('libs/orders/events.ts', "export const Paid = defineEvent('order.paid', 'orders', 1, z.object({}));\n" + PAD);
  w('libs/notify/mailer.ts', 'export class Mailer { send() {} }\n' + PAD);
  w('libs/notify/listener.ts', "import { Paid } from '@app/orders/events';\nexport class Listener {\n  handle(raw) { return Paid.match(raw); }\n}\n" + PAD);
  w('apps/api/main.ts', "import { OrderService } from '@app/orders/order.service';\nexport const svc = OrderService;\n" + PAD);
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

function setup(root: string, notes: Note[] = []) {
  const files = listSourceFiles(root, cfg);
  const graph = buildGraph(cfg, files, (p) => readText(root, p), root);
  const specs = buildNodes({ cfg, graph, readSource: (p) => readText(root, p), readContext: () => null, notes, patternMap: null });
  return { graph, specs };
}

class Counting implements Provider {
  readonly name = 'counting';
  calls = 0;
  private readonly inner = new MockProvider();
  complete(req: LlmRequest): Promise<LlmResponse> {
    this.calls++;
    return this.inner.complete(req);
  }
}

const LIMITS = { maxUses: 8, maxDepth: 4, maxPerUnit: 40 };

const opts = (provider: Provider, extra = {}) => ({ provider, select: () => true, dryRun: false, force: false, concurrency: 3, maxCalls: 1000, log: () => {}, ...extra });

test('graph: units, import edges via tsconfig paths, event flow', () => {
  const { graph } = setup(fixture());
  assert.deepEqual(graph.units.map((u) => u.label), ['app/api', 'domain/notify', 'domain/orders']);
  assert.ok(graph.unitEdges.some((e) => e.from === 'libs/orders' && e.to === 'libs/notify'));
  assert.equal(graph.events.length, 1);
  assert.deepEqual(graph.events[0].producers, ['libs/orders/order.service.ts']);
  assert.deepEqual(graph.events[0].consumers, ['libs/notify/listener.ts']);
  assert.equal(graph.flows.length, 1);
  assert.equal(graph.flows[0].slug, 'order-paid');
});

test('pipeline: second run is fully cached; editing one file regenerates only its ancestors', async () => {
  const root = fixture();
  const cache = new Cache(join(root, 'out/.cache'));
  const p1 = new Counting();
  const first = await runPipeline(setup(root).specs, cache, opts(p1));
  assert.ok(p1.calls > 0);
  assert.equal(first.results.filter((r) => r.status === 'failed').length, 0);

  const p2 = new Counting();
  await runPipeline(setup(root).specs, new Cache(join(root, 'out/.cache')), opts(p2));
  assert.equal(p2.calls, 0, 'nothing changed, nothing regenerated');

  writeFileSync(join(root, 'libs/notify/mailer.ts'), 'export class Mailer { send(to: string) { return to; } }\n' + PAD);
  const p3 = new Counting();
  const third = await runPipeline(setup(root).specs, new Cache(join(root, 'out/.cache')), opts(p3));
  const regenerated = third.results.filter((r) => r.status === 'generated').map((r) => r.id);
  assert.ok(regenerated.includes('file:libs/notify/mailer.ts'));
  assert.ok(!regenerated.includes('file:libs/orders/order.service.ts'), 'unrelated files stay cached');
  // The mock's summary text does not depend on the code, so outputs are unchanged: parents are cut off early instead of cascading.
  // Only the file and the pages that read its source regenerate.
  assert.deepEqual(regenerated.filter((id) => !id.startsWith('concept:')), ['file:libs/notify/mailer.ts']);
  assert.ok(regenerated.some((id) => id.startsWith('concept:')), 'the page that reads the changed source is rewritten');
  assert.ok(!regenerated.some((id) => id.startsWith('unit:') || id === 'system'), 'unchanged page text stops the cascade');
});

test('pipeline: --unit style selection leaves other stale nodes untouched and blocks dependents', async () => {
  const root = fixture();
  const { specs } = setup(root);
  const rep = await runPipeline(specs, new Cache(join(root, 'out/.cache')), opts(new Counting(), { select: (s: any) => s.unitIds.includes('libs/notify') }));
  assert.ok(rep.results.some((r) => r.id === 'file:libs/orders/events.ts' && r.status === 'stale'));
  assert.ok(rep.results.some((r) => r.id === 'system' && r.status === 'blocked'));
});

test('pipeline: failures are retried once, then reported without poisoning the cache', async () => {
  const root = fixture();
  let n = 0;
  const flaky: Provider = { name: 'flaky', complete: async () => ({ text: n++ < 100 ? 'not json' : '{}', inputTokens: 1, outputTokens: 1 }) };
  const cache = new Cache(join(root, 'out/.cache'));
  const rep = await runPipeline(setup(root).specs, cache, opts(flaky));
  assert.ok(rep.results.some((r) => r.status === 'failed'));
  assert.equal(cache.get('file', 'file:libs/notify/mailer.ts'), undefined);
});

test('hallucinated symbols and paths are dropped with a warning', async () => {
  const root = fixture();
  const liar: Provider = {
    name: 'liar',
    complete: async (req) => {
      const fake = req.fake!() as any;
      if (fake.symbols) fake.symbols.push({ name: 'NotARealSymbol', summary: 'x' });
      if (fake.lives) fake.lives.push({ file: 'libs/nope.ts', symbol: '' });
      if (fake.parts) fake.parts.push({ slug: 'x', title: 'x', what: '', files: [], symbols: ['AlsoNotReal'], deeper: false });
      return { text: JSON.stringify(fake), inputTokens: 1, outputTokens: 1 };
    },
  };
  const rep = await runPipeline(setup(root).specs, new Cache(join(root, 'out/.cache')), opts(liar));
  const warnings = rep.results.flatMap((r) => r.warnings);
  assert.ok(warnings.some((w) => w.includes('NotARealSymbol')));
  assert.ok(warnings.some((w) => w.includes('libs/nope.ts')));
  assert.ok(warnings.some((w) => w.includes('AlsoNotReal')));
  assert.ok(![...rep.outputs.values()].some((o: any) => o.symbols?.some((s: any) => s.name === 'NotARealSymbol')));
});

test('render + sync: writes pages, is idempotent, removes pages it no longer renders', async () => {
  const root = fixture();
  const { graph, specs } = setup(root);
  const rep = await runPipeline(specs, new Cache(join(root, 'out/.cache')), opts(new MockProvider()));
  mkdirSync(join(root, 'out'), { recursive: true });
  writeFileSync(join(root, 'out/notes.md'), '# my own notes\n');
  const pages = renderAll(cfg, graph, rep.outputs, rep.stale);
  assert.ok(pages.has('README.md') && pages.has('system.md') && pages.has('flows/order-paid.md') && pages.has('catalog/events.md'));
  const first = syncOutputs(root, 'out', pages, true);
  assert.ok(first.written.length > 0);
  const second = syncOutputs(root, 'out', pages, true);
  assert.deepEqual(second.removed, []);
  assert.equal(second.written.length, 0);
  assert.ok(first.removed.includes('notes.md'));
  assert.match(readFileSync(join(root, 'out/flows/order-paid.md'), 'utf8'), /```mermaid/);
});

test('extractJson tolerates fences and chatter', () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a": {"b": "}"}}\n```'), { a: { b: '}' } });
  assert.throws(() => extractJson('no json here'));
});

test('concepts: one page per concept; shared code is linked to the same page from every user', async () => {
  const root = fixture();
  const { graph, specs } = setup(root);
  const rep = await runPipeline(specs, new Cache(join(root, 'out/.cache')), opts(new MockProvider()));
  const model = buildConceptModel(graph, rep.outputs, LIMITS);
  const mailer = model.concepts.find((c) => c.files.includes('libs/notify/mailer.ts'))!;
  const orders = model.concepts.find((c) => c.files.includes('libs/orders/order.service.ts'))!;
  assert.ok(orders.candidates.includes(mailer.id), 'orders imports the mailer, so it is a candidate');
  const pages = renderAll(cfg, graph, rep.outputs, rep.stale);
  assert.ok(pages.has(mailer.page) && pages.has(orders.page));
  const detail = model.byId.get(`${orders.id}-detail`)!;
  assert.ok(pages.get(orders.page)!.includes(`[Detail of ${orders.title}](${detail.page.split('/').pop()})`), 'story markers become links to the sub-topic page');
  assert.ok(pages.get(orders.page)!.includes('no-such-thing') && !pages.get(orders.page)!.includes('{{'), 'unknown markers fall back to plain text');
  assert.ok(pages.get(detail.page)!.includes(`_Part of [${orders.title}](${orders.slug}.md)_`), 'sub-topic pages link back up');
  assert.ok(pages.get(orders.page)!.includes(`](../${mailer.page.split('/').slice(1).join('/')})`));
  // the flow page links the producer and consumer files to the concept pages that own them
  assert.match(pages.get('flows/order-paid.md')!, /concepts\/domain-orders\//);
  const ids = model.concepts.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('concepts: pages split into sub-topics recursively, structural edges only go deeper', () => {
  const { graph } = setup(fixture());
  const top = (slug: string, files: string[]) => ({ slug, title: slug, gist: 'g', files, uses: [] });
  const part = (slug: string, extra = {}) => ({ slug, title: slug, what: 'w', files: [], symbols: [], deeper: true, ...extra });
  const out = new Map<string, any>([
    ['capmap:libs/orders', { topics: [top('a', ['libs/orders/order.service.ts'])] }],
    ['concept:domain/orders/a', { parts: [part('b'), part('inline', { deeper: false })] }],
    // b names an ancestor (a) as a part and a deeper part c: the ancestor must not become its child
    ['concept:domain/orders/b', { parts: [part('a'), part('c')] }],
    ['concept:domain/orders/c', { parts: [part('d')] }],
  ]);
  const model = buildConceptModel(graph, out, LIMITS);
  const depthOf = (slug: string) => model.byId.get(`concept:domain/orders/${slug}`)?.depth;
  assert.deepEqual(['a', 'b', 'c', 'd'].map(depthOf), [0, 1, 2, 3]);
  assert.equal(depthOf('inline'), undefined, 'a part that is not deeper stays inline');
  assert.deepEqual(model.byId.get('concept:domain/orders/b')!.children, ['concept:domain/orders/c']);
  assert.deepEqual(model.byId.get('concept:domain/orders/a')!.parents, []);
  assert.deepEqual(buildConceptModel(graph, out, { ...LIMITS, maxDepth: 1 }).concepts.map((c) => c.slug), ['a', 'b']);
  assert.deepEqual(buildConceptModel(graph, out, { ...LIMITS, maxPerUnit: 2 }).concepts.map((c) => c.slug), ['a', 'b']);
});

test('pipeline: sub-topics are discovered in rounds, generated once, then cached', async () => {
  const root = fixture();
  const p1 = new Counting();
  const first = await runPipeline(setup(root).specs, new Cache(join(root, 'out/.cache')), opts(p1));
  const ids = first.results.filter((r) => r.level === 'concept').map((r) => r.id);
  assert.ok(ids.some((id) => id.endsWith('-detail')), 'the mock page named a deeper part, which became a page');
  assert.equal(first.results.filter((r) => r.status === 'failed').length, 0);
  const p2 = new Counting();
  await runPipeline(setup(root).specs, new Cache(join(root, 'out/.cache')), opts(p2));
  assert.equal(p2.calls, 0);
});

test('prose: identifiers, topics and events go in code spans; known symbols link; idempotent', () => {
  const { graph } = setup(fixture());
  const model = buildConceptModel(graph, new Map(), LIMITS);
  const prose = new Prose(graph, model);
  const page = { path: 'units/x.md', src: (f: string, l?: number, t?: string) => `[${t}](${f}#L${l})`, page: (to: string, t: string) => `[${t}](${to})` };
  const f = (s: string) => prose.fmt(s, page);
  assert.equal(f("A Kafka event on 'payments.requests' reaches PaymentController."), 'A Kafka event on `payments.requests` reaches `PaymentController`.');
  assert.equal(f('LedgerService emits JournalPosted (ledger.journal_posted) with FEE_AMOUNT.'), '`LedgerService` emits `JournalPosted` (`ledger.journal_posted`) with `FEE_AMOUNT`.');
  assert.equal(f('Uses NestJS and GraphQL with Stripe; see e.g. the docs.'), 'Uses NestJS and GraphQL with Stripe; see e.g. the docs.');
  assert.equal(f('Already `quoted` and [a link](x.md) stay.'), 'Already `quoted` and [a link](x.md) stay.');
  assert.equal(f(f('idempotencyKey in payment.service.ts')), '`idempotencyKey` in `payment.service.ts`');
  assert.equal(f('Mailer sends mail'), 'Mailer sends mail');
  assert.equal(f('Jobs payouts.run-weekly and bis-utils.service.ts.'), 'Jobs `payouts.run-weekly` and `bis-utils.service.ts`.');
  assert.equal(f('The OrderService runs'), 'The [`OrderService`](libs/orders/order.service.ts#L3) runs');
});

test('prose: a title shared by topics in several units is never auto-linked', () => {
  const { graph } = setup(fixture());
  const topic = (slug: string) => ({ slug, title: 'Shared title here', gist: 'g', files: ['libs/orders/events.ts'], uses: [] });
  const out = new Map<string, any>([['capmap:libs/orders', { topics: [topic('one')] }], ['capmap:libs/notify', { topics: [{ ...topic('two'), files: ['libs/notify/mailer.ts'] }] }]]);
  const prose = new Prose(graph, buildConceptModel(graph, out, LIMITS));
  const page = { path: 'x.md', src: () => '', page: (to: string, t: string) => `[${t}](${to})` };
  assert.equal(prose.fmt('See Shared title here.', page), 'See Shared title here.');
});

const NOTE: Note = {
  path: 'interview-prep/01-x/01-orders.md',
  text: '# Orders and events\n\nIntro.\n\n## Domain events and the mailer\n\nOrder events are published when an order is paid, and a listener sends mail.\n\n```ts\n# not a heading\n```\n\n### Order service paying orders\n\nThe order service pays orders.\n\n## Domain events and the mailer\n\nSame heading twice.\n',
};

test('theory: sections are every heading at any depth; fences are skipped; duplicate headings get distinct keys', () => {
  const secs = parseSections(NOTE.text);
  assert.deepEqual(secs.map((x) => x.key), ['Orders and events', 'Orders and events > Domain events and the mailer', 'Orders and events > Domain events and the mailer > Order service paying orders', 'Orders and events > Domain events and the mailer #2']);
  assert.ok(secs[1].text.includes('# not a heading'));
  assert.equal(parseSections('---\ntitle: x\n---\n# A\n').length, 1);
});

test('theory: links are written into notes as marked blocks, reversibly, and hand-written text is never changed', async () => {
  const root = fixture();
  const { graph, specs } = setup(root, [NOTE]);
  const rep = await runPipeline(specs, new Cache(join(root, 'out/.cache')), opts(new MockProvider()));
  const o = rep.outputs.get(`theory:${NOTE.path}`);
  assert.ok(o.sections.length >= 1, 'the mock linked something');
  const model = buildConceptModel(graph, rep.outputs, LIMITS);
  const refs = theoryRefs(rep.outputs, model, graph.files);
  assert.ok(refs.length >= 1);
  const written = renderNote(NOTE, refs, model, rep.outputs, 'out');
  assert.ok(written.includes('<!-- theory-links:start -->') && written.includes('> [!TIP] In this codebase'));
  assert.ok(/\]\(\.\.\/\.\.\/(out\/concepts|libs)\//.test(written), 'links are relative to the note');
  assert.equal(stripBlocks(written), NOTE.text, 'removing the blocks restores the note exactly');
  const again = renderNote({ ...NOTE, text: written }, refs, model, rep.outputs, 'out');
  assert.equal(again, written, 'rendering twice changes nothing');
  assert.equal(renderNote({ ...NOTE, text: written }, [], model, rep.outputs, 'out'), NOTE.text, 'no refs removes the blocks');
  // topic pages list the sections that point at them, and a coverage page exists
  const pages = renderAll(cfg, graph, rep.outputs, rep.stale);
  assert.ok(pages.has('theory-coverage.md'));
  const linkedConcept = refs.find((r) => r.target.startsWith('concept:'));
  if (linkedConcept) assert.match(pages.get(model.byId.get(linkedConcept.target.slice('concept:'.length))!.page)!, /## Theory/);
});

test('theory: an unchanged note and code stay cached; a model that invents candidates or sections is dropped with warnings', async () => {
  const root = fixture();
  const p1 = new Counting();
  await runPipeline(setup(root, [NOTE]).specs, new Cache(join(root, 'out/.cache')), opts(p1));
  const p2 = new Counting();
  await runPipeline(setup(root, [NOTE]).specs, new Cache(join(root, 'out/.cache')), opts(p2));
  assert.equal(p2.calls, 0);
  const liar: Provider = {
    name: 'liar',
    complete: async (req) => {
      const fake = req.fake!() as any;
      if (fake.sections) fake.sections.push({ id: 'S99', coverage: 'here', refs: [{ target: 'C0', how: 'x' }] }, { id: 'S0', coverage: 'here', refs: [{ target: 'C9999', how: 'x' }] });
      return { text: JSON.stringify(fake), inputTokens: 1, outputTokens: 1 };
    },
  };
  const root2 = fixture();
  const rep = await runPipeline(setup(root2, [NOTE]).specs, new Cache(join(root2, 'out/.cache')), opts(liar));
  const w = rep.results.find((r) => r.id === `theory:${NOTE.path}`)!.warnings;
  assert.ok(w.some((x) => x.includes('S99')) && w.some((x) => x.includes('C9999')));
});

test('theory: the block goes before a trailing horizontal rule and removal still restores the note exactly', () => {
  const note: Note = { path: 'interview-prep/01-x/02-y.md', text: '# T\n\nbody\n\n---\n\n## Next\n\ntext\n' };
  const model = buildConceptModel(setup(fixture()).graph, new Map(), LIMITS);
  const ref = { note: note.path, key: 'T', heading: 'T', target: 'file:libs/notify/mailer.ts', how: 'sends mail', coverage: 'here' };
  const out = renderNote(note, [ref], model, new Map(), 'out');
  assert.ok(out.indexOf('theory-links:start') < out.indexOf('\n---\n'), 'before the rule');
  assert.ok(out.includes('(../../libs/notify/mailer.ts)'));
  assert.equal(stripBlocks(out), note.text);
});

test('theory: heading anchors follow what Obsidian resolves', () => {
  const link = (h: string) => noteLink('docs', 'interview-prep/a b/01-x.md', h, 't');
  assert.equal(link('2. CI: the `pipeline` | design'), '[t](../interview-prep/a%20b/01-x.md#2.%20CI%20the%20pipeline%20design)');
});

test('theory: code links land on the exact function, and the topic page is added whenever one exists', async () => {
  const root = fixture();
  const { graph, specs } = setup(root, [NOTE]);
  const rep = await runPipeline(specs, new Cache(join(root, 'out/.cache')), opts(new MockProvider()));
  const model = buildConceptModel(graph, rep.outputs, LIMITS);
  const sym = (rep.outputs.get('file:libs/notify/mailer.ts').symbols as any[])[0];
  assert.ok(sym.line, 'file summaries carry the line of each exported symbol');
  const ref = { note: NOTE.path, key: 'Orders and events', heading: 'Orders and events', target: `symbol:libs/notify/mailer.ts::${sym.name}::${sym.line}`, how: 'sends mail', coverage: 'here' };
  const withDocs = renderNote(NOTE, [ref], model, rep.outputs, 'out');
  assert.ok(withDocs.includes(`[\`${sym.name}\`](../../libs/notify/mailer.ts#L${sym.line})`), 'function-level link');
  assert.ok(/ · \[[^\]]+\]\(\.\.\/\.\.\/out\/concepts\//.test(withDocs), 'plus the topic page that owns the file');
  const noDocs = renderNote(NOTE, [ref], buildConceptModel(graph, new Map(), LIMITS), rep.outputs, 'out');
  assert.ok(noDocs.includes('#L') && !noDocs.includes('out/concepts'), 'without topic pages only the code link remains');
  // the topic page gets a backlink even though the note linked to code
  const pages = renderAll(cfg, graph, new Map([...rep.outputs, ['theory:x', { note: NOTE.path, sections: [{ key: ref.key, heading: ref.heading, coverage: 'here', refs: [{ target: ref.target, how: ref.how }] }], gaps: [] }]]), new Set());
  const owner = model.concepts.find((c) => c.files.includes('libs/notify/mailer.ts'))!;
  assert.match(pages.get(owner.page)!, /## Theory/);
});
