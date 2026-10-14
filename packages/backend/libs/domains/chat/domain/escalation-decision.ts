/**
 * The offline check's decision table (S24 AS-43, AS-44, AS-45). Exactly one outcome; the order below is the
 * precedence when several facts apply. Unknown presence counts as offline (a duplicate push beats a missed one).
 */
export type EscalationOutcome =
  'ineligible' | 'deleted' | 'read' | 'online' | 'coalesced' | 'notified';

export interface EscalationFacts {
  /** Active member of a non-archived channel. */
  eligible: boolean;
  deleted: boolean;
  readSeq: number;
  seq: number;
  online: boolean | 'unknown';
  /** A notification for this (recipient, channel) is inside its window. */
  coalesced: boolean;
}

export function decideEscalation(f: EscalationFacts): EscalationOutcome {
  if (!f.eligible) return 'ineligible';
  if (f.deleted) return 'deleted';
  if (f.readSeq >= f.seq) return 'read';
  if (f.online === true) return 'online';
  if (f.coalesced) return 'coalesced';
  return 'notified';
}
