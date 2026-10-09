import { HttpStatus } from '@nestjs/common';
import { problemDetailsSchema } from '@marketplace-sandbox/contracts';
import { AppError, ErrorArea } from '@app/common/errors/error.types';
import { buildProblemDocument } from './problem-document';

const base = {
  requestId: 'req-12345678',
  instance: '/api/things/1?secret=1',
  typeBaseUrl: 'https://errors.example.test',
};
const make = (over: Partial<ConstructorParameters<typeof AppError>[0]> = {}) =>
  new AppError({
    code: 'conflict',
    status: HttpStatus.CONFLICT,
    title: 'Conflict',
    detail: 'Already exists',
    area: ErrorArea.DOMAIN,
    ...over,
  });

describe('buildProblemDocument', () => {
  it('S54 AS-10: merges extensions, keeps reserved members, and lists Retry-After', () => {
    const doc = buildProblemDocument(
      make({
        extensions: {
          retryAfterSeconds: 7,
          code: 'hacked',
          requestId: 'evil',
          status: 200,
          balance: 3,
        },
        retryAfterSeconds: 7,
      }),
      base,
    );
    expect(doc.body).toMatchObject({
      code: 'conflict',
      requestId: 'req-12345678',
      status: 409,
      balance: 3,
      retryAfterSeconds: 7,
    });
    expect(doc.headers['Retry-After']).toBe('7');
    expect(problemDetailsSchema.safeParse(doc.body).success).toBe(true);
  });

  it('S54 AS-10: strips the query string from instance and builds type from the code', () => {
    const doc = buildProblemDocument(make(), base);
    expect(doc.body.instance).toBe('/api/things/1');
    expect(doc.body.type).toBe('https://errors.example.test/conflict');
  });

  it.each([500, 502, 503, 504])(
    'S54 FR-003: status %i uses the catalogue detail, never the thrown message',
    (status) => {
      const doc = buildProblemDocument(
        make({
          status,
          code: 'internal_error',
          title: 'Internal Server Error',
          detail: 'relation "User" does not exist',
        }),
        { ...base, catalogDetail: 'Something went wrong on our side.' },
      );
      expect(doc.body.detail).toBe('Something went wrong on our side.');
    },
  );

  it('S54 AS-16: a circular extension yields the minimal 500 fallback and never throws', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const doc = buildProblemDocument(make({ extensions: { circular } }), base);
    expect(doc.body.status).toBe(500);
    expect(doc.body.code).toBe('internal_error');
    expect(doc.body.requestId).toBe('req-12345678');
    expect(() => JSON.stringify(doc.body)).not.toThrow();
  });

  it('S54 FR-001: never exposes area, data, causes or stack', () => {
    const doc = buildProblemDocument(
      make({ causes: [new Error('db password=hunter2')] }),
      base,
    );
    expect(Object.keys(doc.body)).not.toEqual(expect.arrayContaining(['area']));
    expect(JSON.stringify(doc.body)).not.toContain('hunter2');
    expect(doc.body).not.toHaveProperty('causes');
    expect(doc.body).not.toHaveProperty('data');
  });
});
