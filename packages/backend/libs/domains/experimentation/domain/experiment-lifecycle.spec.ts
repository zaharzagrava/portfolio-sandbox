import { ExperimentError } from './experiment-errors';
import { decide, type ExperimentCommand } from './experiment-lifecycle';
import type {
  ExperimentDefinition,
  ExperimentStatus,
  StoredExperiment,
} from './experiment-types';

const definition = (
  patch: Partial<ExperimentDefinition> = {},
): ExperimentDefinition => ({
  description: 'gallery layout',
  owner: 'growth',
  unit: 'visitor',
  variants: [
    { key: 'control', weight: 5_000 },
    { key: 'gallery', weight: 5_000 },
  ],
  layer: 'pdp',
  layerFrom: 0,
  layerTo: 5_000,
  metric: 'add_to_cart',
  ...patch,
});

const stored = (
  status: ExperimentStatus,
  patch: Partial<StoredExperiment> = {},
): StoredExperiment => ({
  ...definition(),
  key: 'pdp-layout',
  status,
  version: 3,
  startedAt: status === 'draft' ? null : new Date('2026-10-14T10:00:00Z'),
  stoppedAt: status === 'stopped' ? new Date('2026-10-14T11:00:00Z') : null,
  startedBy: status === 'draft' ? null : 'admin-1',
  stoppedBy: status === 'stopped' ? 'admin-1' : null,
  createdAt: new Date('2026-10-14T09:00:00Z'),
  updatedAt: new Date('2026-10-14T09:00:00Z'),
  ...patch,
});

const save = (
  expectedVersion: number,
  patch: Partial<ExperimentDefinition> = {},
): ExperimentCommand => ({
  type: 'save',
  expectedVersion,
  definition: definition(patch),
});

const rejected = (decision: ReturnType<typeof decide>): string => {
  if (decision.kind !== 'reject')
    throw new Error(`expected a rejection, got ${decision.kind}`);
  return (decision.error as ExperimentError).problem;
};

describe('Experiment lifecycle', () => {
  describe('save', () => {
    it('S39 AS-30: a new key with expectedVersion 0 is created', () => {
      expect(decide(null, save(0))).toEqual({
        kind: 'apply',
        action: 'create',
        definition: definition(),
      });
    });

    it('S39 AS-31: an update of an unknown key with expectedVersion above 0 is not_found', () => {
      expect(rejected(decide(null, save(1)))).toBe('not_found');
      expect(rejected(decide(null, save(7)))).toBe('not_found');
    });

    it('S39 AS-31: a changed definition at the current version is an update, at another version a version_conflict', () => {
      const changed = save(3, { description: 'new words' });
      expect(decide(stored('draft'), changed)).toEqual({
        kind: 'apply',
        action: 'update',
        definition: definition({ description: 'new words' }),
      });
      for (const version of [0, 1, 2, 4])
        expect(
          rejected(
            decide(stored('draft'), save(version, { description: 'x' })),
          ),
        ).toBe('version_conflict');
    });

    it('S39 AS-31: a definition equal to the stored one is a no-op whatever the expected version', () => {
      for (const version of [0, 1, 3, 99])
        expect(decide(stored('draft'), save(version))).toEqual({
          kind: 'noop',
        });
      expect(decide(stored('running'), save(0))).toEqual({ kind: 'noop' });
      expect(decide(stored('stopped'), save(3))).toEqual({ kind: 'noop' });
    });

    it.each([
      [
        'variants',
        {
          variants: [
            { key: 'control', weight: 6_000 },
            { key: 'gallery', weight: 4_000 },
          ],
        },
      ],
      ['layer', { layer: 'other' }],
      ['range from', { layerFrom: 100 }],
      ['range to', { layerTo: 6_000 }],
      ['unit', { unit: 'user' as const }],
      ['metric', { metric: 'click' }],
    ])(
      'S39 AS-35: changing the %s of a running or stopped experiment is experiment_immutable',
      (_field, patch) => {
        for (const status of ['running', 'stopped'] as const)
          expect(rejected(decide(stored(status), save(3, patch)))).toBe(
            'experiment_immutable',
          );
        // A draft takes it.
        expect(decide(stored('draft'), save(3, patch)).kind).toBe('apply');
      },
    );

    it('S39 AS-35: description and owner can change on a running or stopped experiment', () => {
      for (const status of ['running', 'stopped'] as const) {
        const decision = decide(
          stored(status),
          save(3, { description: 'again', owner: 'platform' }),
        );
        expect(decision).toEqual({
          kind: 'apply',
          action: 'update',
          definition: definition({ description: 'again', owner: 'platform' }),
        });
      }
    });

    it('S39 AS-35: a stale version beats immutability (the admin must reload first)', () => {
      expect(
        rejected(decide(stored('running'), save(2, { layer: 'other' }))),
      ).toBe('version_conflict');
    });
  });

  describe('start and stop', () => {
    const start: ExperimentCommand = { type: 'start' };
    const stop: ExperimentCommand = { type: 'stop' };

    it('S39 AS-33: start moves a draft to running, repeats on a running one change nothing', () => {
      expect(decide(stored('draft'), start)).toEqual({
        kind: 'apply',
        action: 'start',
        to: 'running',
      });
      expect(decide(stored('running'), start)).toEqual({ kind: 'noop' });
    });

    it('S39 AS-34: stop moves a running experiment to stopped, repeats on a stopped one change nothing', () => {
      expect(decide(stored('running'), stop)).toEqual({
        kind: 'apply',
        action: 'stop',
        to: 'stopped',
      });
      expect(decide(stored('stopped'), stop)).toEqual({ kind: 'noop' });
    });

    it('S39 AS-34: start on a stopped and stop on a draft experiment are illegal_transition', () => {
      expect(rejected(decide(stored('stopped'), start))).toBe(
        'illegal_transition',
      );
      expect(rejected(decide(stored('draft'), stop))).toBe(
        'illegal_transition',
      );
    });

    it('S39 AS-33: start and stop of an unknown key are not_found', () => {
      expect(rejected(decide(null, start))).toBe('not_found');
      expect(rejected(decide(null, stop))).toBe('not_found');
    });
  });
});
