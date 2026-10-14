import { IDEMPOTENCY_KEY_PATTERN, parseIfMatch } from './request-rules';

describe('S42 request rules (FR-040, FR-049)', () => {
  it.each([
    ['"7"', 7],
    ['7', 7],
    ['W/"12"', 12],
    [' "3" ', 3],
  ])('If-Match %p is version %i', (header, version) => {
    expect(parseIfMatch(header)).toBe(version);
  });

  it('a missing or blank If-Match is 428', () => {
    expect(() => parseIfMatch(undefined)).toThrow(
      expect.objectContaining({ code: 'precondition_required', status: 428 }),
    );
    expect(() => parseIfMatch('  ')).toThrow(
      expect.objectContaining({ code: 'precondition_required' }),
    );
  });

  it.each(['"abc"', '"0"', '"-1"', '*', '"1.5"', '"1234567890"'])(
    'If-Match %p is 400',
    (header) => {
      expect(() => parseIfMatch(header)).toThrow(
        expect.objectContaining({ code: 'validation_failed', status: 400 }),
      );
    },
  );

  it.each([
    ['k', true],
    ['x'.repeat(255), true],
    ['x'.repeat(256), false],
    ['', false],
    ['has space', false],
    ['tab\there', false],
    ['new\nline', false],
    ['ünïcode', false],
  ])('idempotency key %p is %p', (key, valid) => {
    expect(IDEMPOTENCY_KEY_PATTERN.test(key)).toBe(valid);
  });
});
