import { decideEscalation, type EscalationFacts } from './escalation-decision';

const base: EscalationFacts = {
  eligible: true,
  deleted: false,
  readSeq: 0,
  seq: 5,
  online: false,
  coalesced: false,
};

describe('S24 escalation decision (AS-43)', () => {
  it.each([
    ['nothing in the way', {}, 'notified'],
    [
      'recipient left the channel or channel archived or banned',
      { eligible: false },
      'ineligible',
    ],
    ['message deleted', { deleted: true }, 'deleted'],
    ['read exactly the message', { readSeq: 5 }, 'read'],
    ['read beyond the message', { readSeq: 9 }, 'read'],
    ['read just before the message', { readSeq: 4 }, 'notified'],
    ['online', { online: true }, 'online'],
    [
      'presence unknown counts as offline (AS-45)',
      { online: 'unknown' },
      'notified',
    ],
    ['inside the coalescing window', { coalesced: true }, 'coalesced'],
    // precedence when several apply
    [
      'ineligible beats everything',
      {
        eligible: false,
        deleted: true,
        readSeq: 9,
        online: true,
        coalesced: true,
      },
      'ineligible',
    ],
    [
      'deleted beats read, online, coalesced',
      { deleted: true, readSeq: 9, online: true, coalesced: true },
      'deleted',
    ],
    [
      'read beats online and coalesced',
      { readSeq: 9, online: true, coalesced: true },
      'read',
    ],
    ['online beats coalesced', { online: true, coalesced: true }, 'online'],
  ] as const)('S24 AS-43: %s -> %s', (_label, over, outcome) => {
    expect(decideEscalation({ ...base, ...over } as EscalationFacts)).toBe(
      outcome,
    );
  });
});
