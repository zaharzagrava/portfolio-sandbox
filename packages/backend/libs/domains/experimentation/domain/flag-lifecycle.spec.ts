import {
  assertNever,
  decide,
  normalizeDefinition,
  type FlagCommand,
} from './flag-lifecycle';
import type { DefinitionInput } from './flag-validation';
import type { FlagState, FlagStatus } from './flag-types';

const input = (patch: Partial<DefinitionInput> = {}): DefinitionInput => ({
  owner: 'team',
  enabled: true,
  variants: [
    { key: 'off', value: false },
    { key: 'on', value: true },
  ],
  defaultVariant: 'off',
  offVariant: 'off',
  rules: [],
  ...patch,
});

const state = (status: FlagStatus, version = 2): FlagState => ({
  status,
  version,
  definition: normalizeDefinition(input()),
});

const save = (
  patch: Partial<DefinitionInput>,
  expectedVersion: number,
): FlagCommand => ({ type: 'save', input: input(patch), expectedVersion });

const outcome = (current: FlagState | null, command: FlagCommand) => {
  const d = decide(current, command);
  if (d.kind === 'reject') return `reject:${d.error.flagCode}`;
  if (d.kind === 'noop') return 'noop';
  return `apply:${d.action}:${d.status}`;
};

describe('flag lifecycle (state machine)', () => {
  describe('S38 data-model state table: every from-state × command', () => {
    it.each<[string, FlagState | null, FlagCommand, string]>([
      // (none)
      [
        '(none) save enabled',
        null,
        save({ enabled: true }, 0),
        'apply:create:enabled',
      ],
      [
        '(none) save disabled',
        null,
        save({ enabled: false }, 0),
        'apply:create:disabled',
      ],
      [
        '(none) save with a version above 0',
        null,
        save({}, 3),
        'reject:flag_not_found',
      ],
      ['(none) kill', null, { type: 'kill' }, 'reject:flag_not_found'],
      ['(none) restore', null, { type: 'restore' }, 'reject:flag_not_found'],
      ['(none) archive', null, { type: 'archive' }, 'reject:flag_not_found'],
      // enabled
      [
        'enabled save same',
        state('enabled'),
        save({ enabled: true }, 2),
        'noop',
      ],
      [
        'enabled save changed',
        state('enabled'),
        save({ owner: 'other' }, 2),
        'apply:update:enabled',
      ],
      [
        'enabled save disabled',
        state('enabled'),
        save({ enabled: false }, 2),
        'apply:update:disabled',
      ],
      ['enabled kill', state('enabled'), { type: 'kill' }, 'apply:kill:killed'],
      [
        'enabled restore',
        state('enabled'),
        { type: 'restore' },
        'reject:invalid_transition',
      ],
      [
        'enabled archive',
        state('enabled'),
        { type: 'archive' },
        'reject:invalid_transition',
      ],
      // disabled
      [
        'disabled save enabled',
        state('disabled'),
        save({ enabled: true }, 2),
        'apply:update:enabled',
      ],
      [
        'disabled save same',
        state('disabled'),
        save({ enabled: false }, 2),
        'noop',
      ],
      [
        'disabled kill',
        state('disabled'),
        { type: 'kill' },
        'apply:kill:killed',
      ],
      [
        'disabled restore',
        state('disabled'),
        { type: 'restore' },
        'reject:invalid_transition',
      ],
      [
        'disabled archive',
        state('disabled'),
        { type: 'archive' },
        'apply:archive:archived',
      ],
      // killed
      [
        'killed save enabled',
        state('killed'),
        save({ enabled: true }, 2),
        'reject:flag_killed',
      ],
      [
        'killed save disabled, other edit',
        state('killed'),
        save({ enabled: false, owner: 'other' }, 2),
        'apply:update:killed',
      ],
      [
        'killed save disabled, same',
        state('killed'),
        save({ enabled: false }, 2),
        'noop',
      ],
      ['killed kill', state('killed'), { type: 'kill' }, 'noop'],
      [
        'killed restore',
        state('killed'),
        { type: 'restore' },
        'apply:restore:disabled',
      ],
      [
        'killed archive',
        state('killed'),
        { type: 'archive' },
        'apply:archive:archived',
      ],
      // archived
      [
        'archived save enabled',
        state('archived'),
        save({ enabled: true }, 2),
        'reject:flag_archived',
      ],
      [
        'archived save disabled',
        state('archived'),
        save({ enabled: false }, 2),
        'reject:flag_archived',
      ],
      [
        'archived create with its key',
        state('archived'),
        save({}, 0),
        'reject:flag_archived',
      ],
      [
        'archived kill',
        state('archived'),
        { type: 'kill' },
        'reject:flag_archived',
      ],
      [
        'archived restore',
        state('archived'),
        { type: 'restore' },
        'reject:flag_archived',
      ],
      ['archived archive', state('archived'), { type: 'archive' }, 'noop'],
    ])('%s', (_name, current, command, expected) => {
      expect(outcome(current, command)).toBe(expected);
    });
  });

  describe('versions and no-op detection', () => {
    it('S38 AS-04: a stale version with an equal definition is a no-op (safe replay)', () => {
      expect(outcome(state('enabled', 5), save({ enabled: true }, 1))).toBe(
        'noop',
      );
      expect(outcome(state('enabled', 5), save({ enabled: true }, 5))).toBe(
        'noop',
      );
    });

    it('S38 AS-05: a stale version with a different definition is a conflict carrying the current version', () => {
      const d = decide(state('enabled', 5), save({ owner: 'other' }, 4));
      expect(d).toMatchObject({
        kind: 'reject',
        error: { flagCode: 'version_conflict' },
      });
      expect((d as { error: { extensions?: unknown } }).error).toMatchObject({
        extensions: { currentVersion: 5 },
      });
    });

    it('S38 AS-07: creating an existing key with version 0 and another definition is a conflict', () => {
      expect(outcome(state('enabled', 1), save({ owner: 'other' }, 0))).toBe(
        'reject:version_conflict',
      );
    });

    it('equality ignores key order and defaulted fields', () => {
      const stored: FlagState = {
        status: 'enabled',
        version: 1,
        definition: normalizeDefinition(
          input({
            description: '',
            bucketBy: 'userId',
            clientSide: false,
            expiresAt: null,
            variants: [
              { key: 'on', value: { b: 1, a: 2 } },
              { key: 'off', value: false },
            ],
            defaultVariant: 'off',
          }),
        ),
      };
      expect(
        outcome(
          stored,
          save(
            {
              variants: [
                { key: 'on', value: { a: 2, b: 1 } },
                { key: 'off', value: false },
              ],
            },
            1,
          ),
        ),
      ).toBe('noop');
    });

    it('an expiresAt written another way is the same instant', () => {
      const stored: FlagState = {
        status: 'enabled',
        version: 1,
        definition: normalizeDefinition(
          input({ expiresAt: '2030-01-01T00:00:00.000Z' }),
        ),
      };
      expect(
        outcome(stored, save({ expiresAt: '2030-01-01T01:00:00+01:00' }, 1)),
      ).toBe('noop');
    });
  });

  it('assertNever throws on an unknown command', () => {
    expect(() =>
      decide(state('enabled'), { type: 'explode' } as never),
    ).toThrow(/unhandled flag command/);
    expect(() => assertNever('x' as never)).toThrow();
  });
});
