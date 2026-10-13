import {
  assertTransition,
  canTransition,
  IllegalMediaTransitionError,
  MEDIA_STATUSES,
  MediaStatus,
} from './media-status';

const LEGAL: Array<[MediaStatus, MediaStatus]> = [
  ['PENDING_UPLOAD', 'UPLOADED'],
  ['PENDING_UPLOAD', 'PROCESSING'],
  ['PENDING_UPLOAD', 'REJECTED'],
  ['PENDING_UPLOAD', 'EXPIRED'],
  ['PENDING_UPLOAD', 'DELETED'],
  ['UPLOADED', 'PROCESSING'],
  ['PROCESSING', 'READY'],
  ['PROCESSING', 'REJECTED'],
  ['PROCESSING', 'PROCESSING'],
  ['READY', 'DELETED'],
  ['REJECTED', 'DELETED'],
  ['EXPIRED', 'DELETED'],
];
const key = (from: string, to: string) => `${from}>${to}`;
const legal = new Set(LEGAL.map(([from, to]) => key(from, to)));
const pairs = MEDIA_STATUSES.flatMap((from) =>
  MEDIA_STATUSES.map((to) => [from, to] as const),
);

describe('media status machine', () => {
  it('S29 AS-49: there are seven statuses and twelve legal transitions', () => {
    expect(MEDIA_STATUSES).toHaveLength(7);
    expect(LEGAL).toHaveLength(12);
  });

  it.each(pairs)('S29 AS-49: %s -> %s', (from, to) => {
    if (legal.has(key(from, to))) {
      expect(canTransition(from, to)).toBe(true);
      expect(() => assertTransition(from, to)).not.toThrow();
    } else {
      expect(canTransition(from, to)).toBe(false);
      expect(() => assertTransition(from, to)).toThrow(
        IllegalMediaTransitionError,
      );
    }
  });

  it('S29 AS-49: every illegal pair fails with the same message shape', () => {
    const messages = pairs
      .filter(([from, to]) => !legal.has(key(from, to)))
      .map(([from, to]) => {
        try {
          assertTransition(from, to);
        } catch (error) {
          return (error as Error).message.replace(from, 'F').replace(to, 'T');
        }
        return 'no error';
      });
    expect(new Set(messages).size).toBe(1);
  });

  it('S29 AS-49: DELETED is final', () => {
    for (const to of MEDIA_STATUSES)
      expect(canTransition('DELETED', to)).toBe(false);
  });
});
