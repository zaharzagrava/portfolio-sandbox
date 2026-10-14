import { KNOWLEDGE_STATUSES } from '@marketplace-sandbox/contracts';
import { DocumentStatus, canMove, nextStatuses } from './document-state';

const LEGAL: [DocumentStatus, DocumentStatus][] = [
  ['AWAITING_UPLOAD', 'QUEUED'],
  ['QUEUED', 'PROCESSING'],
  ['PROCESSING', 'READY'],
  ['PROCESSING', 'FAILED'],
  ['PROCESSING', 'QUEUED'],
  ['FAILED', 'QUEUED'],
  ['READY', 'QUEUED'],
  ['AWAITING_UPLOAD', 'DELETED'],
  ['QUEUED', 'DELETED'],
  ['PROCESSING', 'DELETED'],
  ['READY', 'DELETED'],
  ['FAILED', 'DELETED'],
];

describe('S47 AS-23: document state machine (R-4)', () => {
  it('S47 AS-23: the status set is the contract set', () => {
    expect(Object.keys(nextStatuses).sort()).toEqual(
      [...KNOWLEDGE_STATUSES].sort(),
    );
  });

  it.each(LEGAL)('S47 AS-23: %s → %s is legal', (from, to) => {
    expect(canMove(from, to)).toBe(true);
  });

  it('S47 AS-23: every pair outside the table is illegal', () => {
    const legal = new Set(LEGAL.map(([f, t]) => `${f}>${t}`));
    const illegal: string[] = [];
    for (const from of KNOWLEDGE_STATUSES)
      for (const to of KNOWLEDGE_STATUSES)
        if (!legal.has(`${from}>${to}`) && canMove(from, to))
          illegal.push(`${from}>${to}`);
    expect(illegal).toEqual([]);
  });

  it('S47 AS-30: only FAILED can be retried and DELETED is final', () => {
    expect(canMove('FAILED', 'QUEUED')).toBe(true);
    expect(canMove('AWAITING_UPLOAD', 'QUEUED')).toBe(true); // uploaded, not retry: the service picks the route
    expect(nextStatuses.DELETED).toEqual([]);
    expect(canMove('DELETED', 'DELETED')).toBe(false);
    expect(canMove('READY', 'READY')).toBe(false);
  });
});
