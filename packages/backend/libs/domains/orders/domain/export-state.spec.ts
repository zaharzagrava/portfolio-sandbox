import { assertNever } from '@app/common/core/assert-never';
import {
  EXPORT_STATUSES,
  canTransition,
  isTerminalExportStatus,
  type ExportStatus,
} from './export-state';

const ALLOWED = new Set([
  'QUEUED>RUNNING',
  'QUEUED>CANCELLED',
  'RUNNING>DONE',
  'RUNNING>FAILED',
  'RUNNING>CANCELLED',
  'RUNNING>QUEUED',
  'DONE>EXPIRED',
]);

const pairs = EXPORT_STATUSES.flatMap((from) =>
  EXPORT_STATUSES.map((to) => [from, to] as const),
);

// Compile-time exhaustiveness: adding a status without a branch fails to compile.
const isFinal = (s: ExportStatus): boolean => {
  switch (s) {
    case 'FAILED':
    case 'CANCELLED':
    case 'EXPIRED':
      return true;
    case 'QUEUED':
    case 'RUNNING':
    case 'DONE':
      return false;
    default:
      return assertNever(s);
  }
};

describe('export state machine', () => {
  it('S12 AS-61: there are six statuses and 36 ordered pairs', () => {
    expect(EXPORT_STATUSES).toHaveLength(6);
    expect(pairs).toHaveLength(36);
  });

  it.each(pairs)('S12 AS-61: %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(ALLOWED.has(`${from}>${to}`));
  });

  it('S12 AS-61: the allowed set is exactly the seven moves', () => {
    const allowed = pairs.filter(([f, t]) => canTransition(f, t));
    expect(allowed).toHaveLength(ALLOWED.size);
  });

  it.each(EXPORT_STATUSES)('S12 AS-61: terminal status of %s', (s) => {
    expect(isTerminalExportStatus(s)).toBe(isFinal(s));
  });
});
