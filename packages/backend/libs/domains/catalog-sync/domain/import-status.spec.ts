import {
  IMPORT_STATUSES,
  checkTransition,
  canTransition,
  isActiveImportStatus,
  isFinalImportStatus,
  isRunningImportStatus,
  type ImportStatus,
} from './import-status';

const ALLOWED: Array<[ImportStatus, ImportStatus]> = [
  ['PENDING_UPLOAD', 'UPLOADED'],
  ['PENDING_UPLOAD', 'CANCELLED'],
  ['PENDING_UPLOAD', 'EXPIRED'],
  ['PENDING_UPLOAD', 'FAILED'],
  ['UPLOADED', 'SCANNING'],
  ['UPLOADED', 'CANCELLED'],
  ['UPLOADED', 'FAILED'],
  ['SCANNING', 'PROCESSING'],
  ['SCANNING', 'CANCELLED'],
  ['SCANNING', 'FAILED'],
  ['PROCESSING', 'DONE'],
  ['PROCESSING', 'CANCELLED'],
  ['PROCESSING', 'FAILED'],
];

const ALL_PAIRS = IMPORT_STATUSES.flatMap((from) =>
  IMPORT_STATUSES.map((to) => [from, to] as [ImportStatus, ImportStatus]),
);

describe('S07 import status machine', () => {
  it('S07 AS-58: there are eight states and 56 ordered pairs', () => {
    expect(IMPORT_STATUSES).toHaveLength(8);
    expect(ALL_PAIRS.filter(([a, b]) => a !== b)).toHaveLength(56);
  });

  it.each(ALL_PAIRS)('S07 AS-58: %s -> %s', (from, to) => {
    const allowed = ALLOWED.some(([a, b]) => a === from && b === to);
    expect(canTransition(from, to)).toBe(allowed);
  });

  it('S07 AS-58: exactly 13 pairs are allowed', () => {
    expect(ALL_PAIRS.filter(([a, b]) => canTransition(a, b))).toHaveLength(13);
  });

  it.each(['DONE', 'FAILED', 'CANCELLED', 'EXPIRED'] as ImportStatus[])(
    'S07 AS-58: %s is final and leaves nowhere',
    (status) => {
      expect(isFinalImportStatus(status)).toBe(true);
      expect(isActiveImportStatus(status)).toBe(false);
      for (const to of IMPORT_STATUSES)
        expect(canTransition(status, to)).toBe(false);
    },
  );

  it('S07 AS-58: the active and running sets are what the slot indexes use', () => {
    expect(IMPORT_STATUSES.filter(isActiveImportStatus)).toEqual([
      'PENDING_UPLOAD',
      'UPLOADED',
      'SCANNING',
      'PROCESSING',
    ]);
    expect(IMPORT_STATUSES.filter(isRunningImportStatus)).toEqual([
      'SCANNING',
      'PROCESSING',
    ]);
  });

  it('S07 AS-58: the path is always UPLOADED -> SCANNING -> PROCESSING, never UPLOADED -> PROCESSING', () => {
    expect(canTransition('UPLOADED', 'PROCESSING')).toBe(false);
  });

  it('S07 AS-58: a stale from is refused, a legal one accepted, an illegal pair named', () => {
    // a second writer applies UPLOADED -> SCANNING to a job already PROCESSING
    expect(checkTransition('PROCESSING', 'UPLOADED', 'SCANNING')).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(checkTransition('UPLOADED', 'UPLOADED', 'SCANNING')).toEqual({
      ok: true,
    });
    expect(checkTransition('UPLOADED', 'UPLOADED', 'DONE')).toEqual({
      ok: false,
      reason: 'illegal',
    });
  });
});
