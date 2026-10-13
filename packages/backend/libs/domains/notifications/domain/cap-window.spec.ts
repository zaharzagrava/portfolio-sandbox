import { CAP_RULES, admitsWithin, inWindow } from './cap-window';

describe('S28 AS-38: rolling cap window arithmetic', () => {
  const at = (iso: string) => Date.parse(`2026-10-13T${iso}Z`);
  const push = CAP_RULES.push!;

  it('limits per channel: push 3/hour, e-mail 2/24 h, SMS 1/24 h; no cap on the inbox', () => {
    expect(CAP_RULES.push).toEqual({ limit: 3, windowMs: 3_600_000 });
    expect(CAP_RULES.email).toEqual({ limit: 2, windowMs: 86_400_000 });
    expect(CAP_RULES.sms).toEqual({ limit: 1, windowMs: 86_400_000 });
    expect(CAP_RULES.inapp).toBeUndefined();
  });

  it.each([
    ['inside the window', '10:30:00', '11:00:00', true],
    ['exactly one window ago has left it', '10:00:00', '11:00:00', false],
    ['one second younger than the window', '10:00:01', '11:00:00', true],
  ])('%s', (_name, admitted, now, expected) => {
    expect(inWindow(at(admitted), new Date(at(now)), push)).toBe(expected);
  });

  it('the AS-38 sequence: 4th at 10:59:59 is refused, 5th at 11:00:11 is admitted', () => {
    const earlier = [at('10:00:10'), at('10:00:30'), at('10:00:40')];
    expect(admitsWithin(earlier, new Date(at('10:59:59')), push)).toBe(false);
    expect(admitsWithin(earlier, new Date(at('11:00:11')), push)).toBe(true);
  });
});
