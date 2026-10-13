import {
  assertVideoTransition,
  canTransitionVideo,
  IllegalVideoTransitionError,
  isTerminalVideoStatus,
  nextVideoStatuses,
  sqlCheckList,
  STATUS_ACTOR_TYPES,
  VIDEO_CONTENT_TYPES,
  VIDEO_STATUSES,
  VIDEO_VISIBILITIES,
  type VideoStatus,
} from './video-status';

/** FR-056: the whole table of legal transitions; every other pair of the 7x7 matrix must be refused. */
const LEGAL: [VideoStatus, VideoStatus][] = [
  ['UPLOADING', 'UPLOADED'],
  ['UPLOADING', 'EXPIRED'],
  ['UPLOADED', 'PROCESSING'],
  ['UPLOADED', 'FAILED'],
  ['PROCESSING', 'READY'],
  ['PROCESSING', 'FAILED'],
  ['FAILED', 'PROCESSING'],
  ['UPLOADING', 'DELETED'],
  ['UPLOADED', 'DELETED'],
  ['PROCESSING', 'DELETED'],
  ['READY', 'DELETED'],
  ['FAILED', 'DELETED'],
  ['EXPIRED', 'DELETED'],
];
const key = (from: string, to: string) => `${from}>${to}`;
const legal = new Set(LEGAL.map(([from, to]) => key(from, to)));
const pairs = VIDEO_STATUSES.flatMap((from) =>
  VIDEO_STATUSES.map((to) => [from, to] as const),
);

describe('video status machine', () => {
  it('S30 AS-10: there are seven statuses and thirteen legal transitions', () => {
    expect(VIDEO_STATUSES).toHaveLength(7);
    expect(LEGAL).toHaveLength(13);
    expect(pairs).toHaveLength(49);
  });

  it.each(pairs)('S30 AS-10: %s -> %s', (from, to) => {
    if (legal.has(key(from, to))) {
      expect(canTransitionVideo(from, to)).toBe(true);
      expect(() => assertVideoTransition(from, to)).not.toThrow();
    } else {
      expect(canTransitionVideo(from, to)).toBe(false);
      expect(() => assertVideoTransition(from, to)).toThrow(
        IllegalVideoTransitionError,
      );
    }
  });

  it('S30 AS-47: DELETED is terminal and every other status can be deleted', () => {
    expect(nextVideoStatuses('DELETED')).toEqual([]);
    expect(isTerminalVideoStatus('DELETED')).toBe(true);
    for (const s of VIDEO_STATUSES.filter((x) => x !== 'DELETED')) {
      expect(isTerminalVideoStatus(s)).toBe(false);
      expect(canTransitionVideo(s, 'DELETED')).toBe(true);
    }
  });

  it('S30 AS-27: READY is reachable only from PROCESSING', () => {
    const into = VIDEO_STATUSES.filter((f) => canTransitionVideo(f, 'READY'));
    expect(into).toEqual(['PROCESSING']);
  });

  it('S30 AS-46: the error names both statuses', () => {
    expect(() => assertVideoTransition('READY', 'PROCESSING')).toThrow(
      'illegal video transition READY -> PROCESSING',
    );
  });

  it('S30 AS-10: the union equals the CHECK vocabulary of data-model.md', () => {
    expect([...VIDEO_STATUSES]).toEqual([
      'UPLOADING',
      'UPLOADED',
      'PROCESSING',
      'READY',
      'FAILED',
      'EXPIRED',
      'DELETED',
    ]);
    expect([...VIDEO_VISIBILITIES]).toEqual(['public', 'unlisted']);
    expect([...VIDEO_CONTENT_TYPES]).toEqual([
      'video/mp4',
      'video/quicktime',
      'video/webm',
    ]);
    expect([...STATUS_ACTOR_TYPES]).toEqual(['user', 'system', 'worker']);
  });

  it('S30 AS-10: sqlCheckList renders the list a migration CHECK uses', () => {
    expect(sqlCheckList(VIDEO_VISIBILITIES)).toBe("'public','unlisted'");
    expect(sqlCheckList(VIDEO_STATUSES)).toBe(
      "'UPLOADING','UPLOADED','PROCESSING','READY','FAILED','EXPIRED','DELETED'",
    );
  });
});
