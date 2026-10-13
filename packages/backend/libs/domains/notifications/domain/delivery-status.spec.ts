import fc from 'fast-check';
import { DELIVERY_STATUSES, type DeliveryStatus } from './types';
import { nextStatus, rankOf } from './delivery-status';

const PRE_SEND: DeliveryStatus[] = [
  'suppressed',
  'capped',
  'skipped',
  'expired',
];
const SENT_OR_LATER: DeliveryStatus[] = [
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
];
const status = fc.constantFrom(...DELIVERY_STATUSES);

describe('S28 AS-71: a delivery status only moves forward (pure)', () => {
  it('the rank order: queued < delayed < sent < delivered < bounced < complained', () => {
    const order: DeliveryStatus[] = [
      'queued',
      'delayed',
      'sent',
      'delivered',
      'bounced',
      'complained',
    ];
    for (let i = 1; i < order.length; i++)
      expect(rankOf(order[i])).toBeGreaterThan(rankOf(order[i - 1]));
    for (const s of ['failed', ...PRE_SEND] as DeliveryStatus[])
      expect(rankOf(s)).toBe(rankOf('bounced'));
  });

  it.each([
    ['delivered', 'complained', 'complained'],
    ['complained', 'delivered', 'complained'],
    ['delivered', 'sent', 'delivered'],
    ['sent', 'delivered', 'delivered'],
    ['bounced', 'delivered', 'bounced'],
    ['failed', 'delivered', 'failed'],
    ['sent', 'failed', 'failed'],
    ['delivered', 'bounced', 'bounced'],
    ['bounced', 'complained', 'complained'],
    ['complained', 'bounced', 'complained'],
    ['queued', 'delayed', 'delayed'],
    ['delayed', 'sent', 'sent'],
    ['sent', 'sent', 'sent'],
    ['complained', 'complained', 'complained'],
    ['bounced', 'failed', 'bounced'],
  ] as const)('%s then %s gives %s', (current, incoming, expected) => {
    expect(nextStatus(current, incoming)).toBe(expected);
  });

  it.each(PRE_SEND)(
    'the pre-send terminal %s is reachable from queued and delayed only',
    (terminal) => {
      expect(nextStatus('queued', terminal)).toBe(terminal);
      expect(nextStatus('delayed', terminal)).toBe(terminal);
      for (const later of SENT_OR_LATER)
        expect(nextStatus(later, terminal)).toBe(later);
    },
  );

  it.each(PRE_SEND)(
    'a delivery that ended as %s never reaches sent or delivered',
    (terminal) => {
      expect(nextStatus(terminal, 'sent')).toBe(terminal);
      expect(nextStatus(terminal, 'delivered')).toBe(terminal);
    },
  );

  it('property: over any sequence the standing status never has a lower rank than an earlier one', () => {
    fc.assert(
      fc.property(fc.array(status, { minLength: 1, maxLength: 30 }), (seq) => {
        let current: DeliveryStatus = 'queued';
        let best = rankOf(current);
        for (const incoming of seq) {
          current = nextStatus(current, incoming);
          expect(rankOf(current)).toBeGreaterThanOrEqual(best);
          best = rankOf(current);
        }
      }),
    );
  });

  it('property: complained is final, and the same status twice changes nothing', () => {
    fc.assert(
      fc.property(status, status, (a, b) => {
        expect(nextStatus('complained', a)).toBe('complained');
        const once = nextStatus(a, b);
        expect(nextStatus(once, b)).toBe(once);
      }),
    );
  });
});
