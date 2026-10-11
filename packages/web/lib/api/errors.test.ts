import { describe, expect, it } from 'vitest';
import { apiErrorMessage, problemFromError } from './errors';

describe('apiErrorMessage', () => {
  it('uses RFC 7807 detail from the backend', () => {
    expect(apiErrorMessage({ response: { data: { title: 'HTTP Exception', detail: 'Email already registered' } } }, 'x')).toBe('Email already registered');
  });

  it('joins validation message arrays', () => {
    expect(apiErrorMessage({ response: { data: { message: ['email must be an email', 'password too short'] } } }, 'x')).toBe(
      'email must be an email, password too short',
    );
  });

  it('falls back on network errors and non-JSON bodies', () => {
    expect(apiErrorMessage(new Error('Network Error'), 'Try again')).toBe('Try again');
    expect(apiErrorMessage({ response: { data: '<html>502</html>' } }, 'Try again')).toBe('Try again');
    expect(apiErrorMessage({ response: { data: { detail: '   ' } } }, 'Try again')).toBe('Try again');
  });
});

describe('problemFromError', () => {
  it('W01 AS-67: keeps only status, code, field errors, wait and request id - never title or detail', () => {
    const problem = problemFromError({
      response: {
        status: 422,
        headers: { 'retry-after': '7' },
        data: {
          title: 'Unprocessable',
          detail: 'secret server text',
          code: 'validation_failed',
          requestId: 'req-1',
          errors: [{ field: 'email', code: 'invalid_email', message: 'server text' }, { nope: true }],
        },
      },
    });
    expect(problem).toEqual({
      status: 422,
      code: 'validation_failed',
      errors: [{ field: 'email', code: 'invalid_email' }],
      retryAfterSeconds: 7,
      requestId: 'req-1',
    });
    expect(JSON.stringify(problem)).not.toMatch(/secret|Unprocessable|server text/);
  });

  it('W01 AS-67: status 0 when there was no response, and tolerates a non-object body', () => {
    expect(problemFromError(new Error('Network Error'))).toEqual({ status: 0, errors: [] });
    expect(problemFromError({ response: { status: 502, data: '<html>' } })).toEqual({ status: 502, errors: [] });
  });
});
