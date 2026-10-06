import { describe, expect, it } from 'vitest';
import { apiErrorMessage } from './errors';

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
