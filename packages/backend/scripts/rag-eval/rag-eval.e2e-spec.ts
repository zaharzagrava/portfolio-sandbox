import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KnowledgeSearchService } from '@app/domains/assistant';
import {
  createKnowledgeApp,
  ESIM_MANUAL,
  type KnowledgeTestApp,
  type Seller,
} from '../../libs/domains/assistant/testing/knowledge.fixtures';
import {
  EXIT,
  GoldenFileError,
  main,
  parseGolden,
  runEval,
  type GoldenCase,
} from './rag-eval';

describe('RAG: evaluation harness', () => {
  let t: KnowledgeTestApp;
  let s: Seller;
  let dir: string;

  beforeAll(async () => {
    t = await createKnowledgeApp();
    dir = mkdtempSync(join(tmpdir(), 'rag-eval-'));
  }, 180_000);
  afterAll(() => t.close());
  beforeEach(async () => {
    await t.reset();
    s = await t.seller();
    await t.index(s, 'Pixel 10 manual', ESIM_MANUAL, {
      productId: s.product.id,
    });
    await t.index(
      s,
      'Returns policy',
      '# Returns\nReturns are accepted within thirty days of delivery.',
    );
  });

  const scope = () => ({ kind: 'shop', shopId: s.shopId }) as const;
  const goldenCases = (): GoldenCase[] => [
    {
      question: 'Does the Pixel 10 support eSIM?',
      scope: scope(),
      expectedDocuments: ['Pixel 10 manual'],
    },
    {
      question: 'Are returns accepted within thirty days?',
      scope: scope(),
      expectedDocuments: ['Returns policy'],
    },
    {
      question: 'zebra migration patterns savanna',
      scope: scope(),
      expectedDocuments: ['Pixel 10 manual'],
    }, // a miss
  ];
  const run = (cases: GoldenCase[], minRecall: number, k = 6) => {
    const lines: string[] = [];
    const search = t.app.get(KnowledgeSearchService);
    return runEval({
      cases,
      k,
      minRecall,
      search: (sc, q, o) => search.search(sc, q, o),
      log: (l) => lines.push(l),
    }).then((r) => ({ ...r, lines }));
  };
  const writeGolden = (name: string, content: unknown) => {
    const file = join(dir, name);
    writeFileSync(
      file,
      typeof content === 'string' ? content : JSON.stringify(content),
    );
    return file;
  };

  it('S47 AS-49: prints recall@k and MRR per question and in total, and makes no model call', async () => {
    const { report, lines } = await run(goldenCases(), 0.5);

    expect(report.cases).toBe(3);
    expect(report.hits).toBe(2);
    expect(report.recallAtK).toBeCloseTo(2 / 3, 12);
    expect(report.mrr).toBeGreaterThan(0.5);
    expect(report.mrr).toBeLessThanOrEqual(2 / 3);
    expect(lines).toHaveLength(4);
    expect(lines.slice(0, 3).map((l) => l[0])).toEqual(['✓', '✓', '✗']);
    expect(lines[3]).toMatch(
      /recall@6 = 0\.667\s+MRR = 0\.\d{3}\s+\(3 questions\)/,
    );
    expect(t.llm.requests).toEqual([]);
    expect(t.recorder.records).toEqual([]);
  });

  it('S47 AS-49: exits 1 when recall@k is below the minimum and 0 otherwise', async () => {
    expect((await run(goldenCases(), 0.8)).exitCode).toBe(EXIT.belowMinimum);
    expect((await run(goldenCases(), 2 / 3)).exitCode).toBe(EXIT.ok);
    expect((await run(goldenCases().slice(0, 2), 0.8)).exitCode).toBe(EXIT.ok);
  });

  it('S47 AS-49: a malformed golden file exits 2 naming the offending case, before anything boots', async () => {
    const bad = [
      ['not JSON', '{oops', null],
      ['an empty list', '[]', null],
      [
        'a case without a question',
        JSON.stringify([
          goldenCases()[0],
          { ...goldenCases()[1], question: '' },
        ]),
        1,
      ],
      [
        'a case with an unknown scope kind',
        JSON.stringify([{ ...goldenCases()[0], scope: { kind: 'galaxy' } }]),
        0,
      ],
      [
        'a case with no expected documents',
        JSON.stringify([
          goldenCases()[0],
          goldenCases()[1],
          { ...goldenCases()[2], expectedDocuments: [] },
        ]),
        2,
      ],
      [
        'a scope with a bad id',
        JSON.stringify([
          { ...goldenCases()[0], scope: { kind: 'shop', shopId: 'x' } },
        ]),
        0,
      ],
    ] as const;
    for (const [name, content, index] of bad) {
      expect(() => parseGolden(content)).toThrow(GoldenFileError);
      try {
        parseGolden(content);
      } catch (error) {
        expect([name, (error as GoldenFileError).caseIndex]).toEqual([
          name,
          index,
        ]);
      }
    }
    const errors = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const file = writeGolden('bad.json', bad[2][1]);
    expect(await main([file])).toBe(EXIT.malformed);
    expect(errors.mock.calls.flat().join(' ')).toMatch(/case 1/);
    expect(await main([join(dir, 'does-not-exist.json')])).toBe(EXIT.malformed);
    errors.mockRestore();
  });

  it('S47 AS-49: the real command boots only the retrieval module and reports against the real index', async () => {
    const file = writeGolden('golden.json', goldenCases().slice(0, 2));
    const result = spawnSync(
      'node',
      [
        '-r',
        './scripts/preload-contracts.cjs',
        '-r',
        'ts-node/register',
        '-r',
        'tsconfig-paths/register',
        'scripts/rag-eval/rag-eval.ts',
        '--golden',
        file,
        '--k',
        '6',
      ],
      {
        cwd: join(__dirname, '../..'),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          TS_NODE_TRANSPILE_ONLY: '1',
          RAG_EVAL_MIN_RECALL: '0.8',
        },
        encoding: 'utf8',
        timeout: 170_000,
      },
    );
    expect(result.stderr).not.toMatch(/Error|Nest can't resolve/);
    expect(result.stdout).toMatch(/recall@6 = 1\.000/);
    expect(result.status).toBe(EXIT.ok);

    const failing = writeGolden('failing.json', [goldenCases()[2]]);
    const below = spawnSync(
      'node',
      [
        '-r',
        './scripts/preload-contracts.cjs',
        '-r',
        'ts-node/register',
        '-r',
        'tsconfig-paths/register',
        'scripts/rag-eval/rag-eval.ts',
        failing,
      ],
      {
        cwd: join(__dirname, '../..'),
        env: { ...process.env, NODE_ENV: 'test', TS_NODE_TRANSPILE_ONLY: '1' },
        encoding: 'utf8',
        timeout: 170_000,
      },
    );
    expect(below.status).toBe(EXIT.belowMinimum);
  }, 400_000);
});
