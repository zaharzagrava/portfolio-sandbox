import { isValidRequestId, resolveRequestId } from './request-id';

describe('request id', () => {
  it('S54 AS-18: keeps a valid inbound id', () => {
    expect(resolveRequestId('abc-12345.XYZ_9')).toBe('abc-12345.XYZ_9');
    expect(isValidRequestId('0197e3a0-0000-7000-8000-000000000000')).toBe(true);
  });

  it.each([
    ['too short', 'abc'],
    ['too long', 'a'.repeat(129)],
    ['control characters', 'abcdef\n12345'],
    ['space', 'abcdef 12345'],
    ['empty', ''],
    ['duplicated header (array)', ['abcdefgh1', 'abcdefgh2']],
    ['duplicated header (comma-joined)', 'abcdefgh1, abcdefgh2'],
    ['missing', undefined],
  ])(
    'S54 AS-18: replaces an invalid id (%s) with a generated UUIDv7',
    (_label, value) => {
      const id = resolveRequestId(value as string | string[] | undefined);
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    },
  );
});
