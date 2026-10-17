import * as encoding from 'lib0/encoding';
import {
  FrameRate,
  abilityAllows,
  checkFrameSize,
  classifyFrame,
  isEmptyStateFrame,
  type Ability,
  type FrameKind,
} from './frame-policy';

const frame = (...numbers: number[]): Uint8Array => {
  const enc = encoding.createEncoder();
  for (const n of numbers) encoding.writeVarUint(enc, n);
  return encoding.toUint8Array(enc);
};

describe('frame policy', () => {
  it.each<[string, Uint8Array, FrameKind | 'malformed']>([
    ['sync step 1', frame(0, 0), 'sync-step1'],
    ['sync step 2', frame(0, 1), 'sync-step2'],
    ['sync update', frame(0, 2), 'sync-update'],
    ['awareness', frame(1), 'awareness'],
    ['query awareness', frame(3), 'query-awareness'],
    ['empty frame', new Uint8Array(0), 'malformed'],
    ['unknown message type', frame(9), 'malformed'],
    ['unknown sync type', frame(0, 7), 'malformed'],
    ['sync without a sync type', frame(0), 'malformed'],
    ['a type the server only sends', frame(4), 'malformed'],
  ])('S06 AS-19: classifies %s', (_label, bytes, expected) => {
    expect(classifyFrame(bytes)).toBe(expected);
  });

  const table: [Ability, FrameKind, boolean][] = [
    ['write', 'sync-step1', true],
    ['write', 'sync-step2', true],
    ['write', 'sync-update', true],
    ['write', 'awareness', true],
    ['write', 'query-awareness', true],
    ['read', 'sync-step1', true],
    ['read', 'sync-step2', false],
    ['read', 'sync-update', false],
    ['read', 'awareness', true],
    ['read', 'query-awareness', true],
  ];

  it.each(table)(
    'S06 AS-22: ability %s with frame %s allowed = %s',
    (ability, kind, allowed) => {
      expect(abilityAllows(ability, kind)).toBe(allowed);
    },
  );

  it.each<[FrameKind, number, 'ok' | 'too_large']>([
    ['sync-update', 512 * 1024, 'ok'],
    ['sync-update', 512 * 1024 + 1, 'too_large'],
    ['sync-step2', 512 * 1024 + 1, 'too_large'],
    ['awareness', 8 * 1024, 'ok'],
    ['awareness', 8 * 1024 + 1, 'too_large'],
    ['sync-step1', 8 * 1024 + 1, 'ok'],
  ])('S06 AS-19: size of %s of %i bytes is %s', (kind, size, expected) => {
    expect(checkFrameSize(kind, size)).toBe(expected);
  });

  it('S06 AS-22: the empty step 2 that answers the server step 1 is not a write, a step 2 with content is', () => {
    const withUpdate = (update: number[]) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, 0);
      encoding.writeVarUint(enc, 1);
      encoding.writeVarUint8Array(enc, Uint8Array.from(update));
      return encoding.toUint8Array(enc);
    };
    expect(isEmptyStateFrame(withUpdate([0, 0]))).toBe(true);
    expect(
      isEmptyStateFrame(
        withUpdate([1, 1, 1, 0, 4, 1, 5, 116, 105, 116, 108, 101, 0]),
      ),
    ).toBe(false);
    expect(isEmptyStateFrame(frame(1))).toBe(false); // presence is not a state frame
    expect(isEmptyStateFrame(new Uint8Array(0))).toBe(false);
  });

  it('S06 AS-19: the 201st frame inside one second exceeds the rate, the next second starts again', () => {
    const rate = new FrameRate();
    for (let i = 0; i < 200; i++) expect(rate.hit(10_000 + i)).toBe(false);
    expect(rate.hit(10_500)).toBe(true);
    expect(rate.hit(11_001)).toBe(false);
  });
});
