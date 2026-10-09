import { problemDetailsSchema } from '@marketplace-sandbox/contracts';

const valid = {
  type: 'https://errors.example.test/not_found',
  title: 'Not Found',
  status: 404,
  detail: 'Not Found',
  instance: '/api/things/1',
  code: 'not_found',
  requestId: '0197e3a0-0000-7000-8000-000000000000',
};

describe('problemDetailsSchema', () => {
  it('S54 AS-15: accepts a valid document and extension members', () => {
    expect(problemDetailsSchema.safeParse(valid).success).toBe(true);
    expect(
      problemDetailsSchema.safeParse({
        ...valid,
        retryAfter: 5,
        errors: [{ field: 'name', code: 'required' }],
      }).success,
    ).toBe(true);
  });

  it('S54 AS-15: rejects a document without code', () => {
    const { code: _code, ...noCode } = valid;
    expect(problemDetailsSchema.safeParse(noCode).success).toBe(false);
  });

  it.each(['area', 'data', 'causes'])(
    'S54 AS-15: rejects the internal member %s',
    (member) => {
      expect(
        problemDetailsSchema.safeParse({ ...valid, [member]: 'x' }).success,
      ).toBe(false);
    },
  );
});
