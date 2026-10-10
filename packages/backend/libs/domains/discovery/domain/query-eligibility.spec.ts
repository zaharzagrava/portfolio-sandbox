import { containsBlocked, isEligibleQuery } from './query-eligibility';

const BLOCKLIST = ['fake', 'counterfeit', 'stolen', 'hack', 'hacked'];

describe('query eligibility', () => {
  it.each([
    ['iphone 17', true],
    ['cheap iphone', true],
    ['usb-c cable', true],
    ['fake iphone', false],
    ['iphone hacked', false],
    ['stolen bikes', false],
    ['fakery', true], // whole word only
    ['hackathon kit', true],
    ['a', false], // under two characters
    ['', false],
    ['  iphone', false], // not normalised
    ['IPHONE', false], // not lower case
    ['iphone   17', false],
    ['ann@example.com', false],
    ['call 555 123 456', false], // nine digits
    ['4111 1111 1111 1111', false], // card-like
    ['4111-1111-1111-1111', false],
    ['order 12345678', true], // eight digits are fine
    ['[redacted]', false],
    ['phone [redacted] case', false],
  ])('S33 AS-38: %j → eligible %s', (query, expected) => {
    expect(isEligibleQuery(query, BLOCKLIST)).toBe(expected);
  });

  it.each([
    ['Cheap iPhone Stand', ['cheap'], true],
    ['cheapest stand', ['cheap'], false],
    ['stand, cheap!', ['cheap'], true],
    ['iphone stand', [], false],
    ['FAKE plant', ['fake'], true],
  ])('S33 AS-12: containsBlocked(%j, %j) → %s', (text, list, expected) => {
    expect(containsBlocked(text, list)).toBe(expected);
  });
});
