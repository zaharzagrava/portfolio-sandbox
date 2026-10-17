import { LAMBDAS } from './lambdas.manifest';
import { expandManifest, type LambdaSpec } from './lambda-spec';
import {
  connectionBudgetUse,
  findManifestProblems,
  ManifestError,
  validateManifest,
} from './validate-manifest';

const base: LambdaSpec = {
  name: 'f',
  entry: 'handlers/f.js',
  queue: 'f-queue',
  fifo: false,
  timeoutSec: 30,
  memoryMb: 512,
  batchSize: 5,
  maxConcurrency: 10,
  visibilityTimeoutSec: 180,
  maxReceiveCount: 5,
  dbPoolMax: 2,
};
const withDlq: LambdaSpec = {
  ...base,
  deadLetter: {
    entry: 'handlers/f-dlq.js',
    batchSize: 5,
    maxConcurrency: 5,
    timeoutSec: 30,
  },
};

describe('manifest validation', () => {
  it('the shipped manifest is valid, expands the dead-letter handler and counts 650 connections', () => {
    const entries = expandManifest(LAMBDAS);
    expect(() => validateManifest(entries)).not.toThrow();
    const dlq = entries.find((e) => e.name === 'document-extractor-dlq');
    expect(dlq).toMatchObject({
      queue: 'onboarding-documents-dlq',
      batchSize: 5,
      maxConcurrency: 5,
      visibilityTimeoutSec: 270,
      deadLetterOf: 'document-extractor',
    });
    expect(connectionBudgetUse(entries)).toBe(650);
  });

  it.each([
    ['179 s', 179, 1],
    ['180 s', 180, 0],
  ])(
    'S55 AS-28: timeout 30 s with visibility %s gives %i visibility problem(s)',
    (_n, visibility, count) => {
      const problems = findManifestProblems([
        { ...base, visibilityTimeoutSec: visibility },
      ]);
      expect(
        problems.filter((p) => p.field === 'visibilityTimeoutSec'),
      ).toHaveLength(count);
      if (count) expect(problems[0]).toMatchObject({ function: 'f' });
      if (count) expect(problems[0].message).toContain('179');
    },
  );

  it('S55 AS-28: the rule also applies to an expanded dead-letter entry', () => {
    const entries = expandManifest([
      {
        ...withDlq,
        deadLetter: { ...withDlq.deadLetter!, visibilityTimeoutSec: 179 },
      },
    ]);
    expect(findManifestProblems(entries)).toEqual([
      expect.objectContaining({
        function: 'f-dlq',
        field: 'visibilityTimeoutSec',
      }),
    ]);
  });

  const row = (field: string, entries: LambdaSpec[], at: string) =>
    [at, field, entries] as const;
  it.each([
    row('fifo', [{ ...base, fifo: true }], 'FIFO flag without the suffix'),
    row(
      'fifo',
      [{ ...base, queue: 'f.fifo', fifo: false }],
      'suffix without the flag',
    ),
    row(
      'batchSize',
      [{ ...base, queue: 'f.fifo', fifo: true, batchSize: 11 }],
      'FIFO batch above 10',
    ),
    row(
      'maxConcurrency',
      [{ ...base, maxConcurrency: 1 }],
      'concurrency below 2',
    ),
    row(
      'timeoutSec',
      [{ ...base, timeoutSec: 901, visibilityTimeoutSec: 6000 }],
      'timeout above 900',
    ),
    row('memoryMb', [{ ...base, memoryMb: 64 }], 'memory below 128'),
    row('memoryMb', [{ ...base, memoryMb: 20000 }], 'memory above 10240'),
    row('queue', [base, { ...base, name: 'g' }], 'two functions on one queue'),
    row(
      'maxReceiveCount',
      [{ ...base, maxReceiveCount: 0 }],
      'receive limit below 1',
    ),
    row(
      'groupId',
      [{ ...base, groupId: 'g' }],
      'FIFO-only option on a standard queue (L-001)',
    ),
    row(
      'maxConcurrency × dbPoolMax',
      [{ ...base, maxConcurrency: 600, dbPoolMax: 2 }],
      'connection budget exceeded',
    ),
  ])('S55 AS-30: %s is rejected on %s', (_at, field, entries) => {
    const problems = findManifestProblems(expandManifest([...entries]));
    expect(problems.map((p) => p.field)).toContain(field);
    expect(() => validateManifest(expandManifest([...entries]))).toThrow(
      ManifestError,
    );
  });

  it('S55 AS-30: a dead-letter handler whose queue is not the dead-letter queue of an entry is rejected', () => {
    const entries = expandManifest([withDlq]).map((e) =>
      e.deadLetterOf ? { ...e, queue: 'somewhere-else' } : e,
    );
    expect(findManifestProblems(entries)).toEqual([
      expect.objectContaining({ function: 'f-dlq', field: 'queue' }),
    ]);
  });

  it('S55 AS-30: the dead-letter handler is counted in the connection budget', () => {
    const entries = expandManifest([{ ...withDlq, maxConcurrency: 490 }]);
    // 490 × 2 + 5 × 2 = 990 passes; 495 × 2 + 10 = 1000 passes; 496 × 2 + 10 = 1002 fails
    expect(findManifestProblems(entries)).toEqual([]);
    expect(
      findManifestProblems(
        expandManifest([{ ...withDlq, maxConcurrency: 496 }]),
      ),
    ).toEqual([
      expect.objectContaining({ field: 'maxConcurrency × dbPoolMax' }),
    ]);
  });
});
