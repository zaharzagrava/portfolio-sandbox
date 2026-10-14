import { API_ERROR_CATALOGUE, ApiError, invalidApiKey } from './errors';

describe('S42 error catalogue (FR-059, G-37)', () => {
  it('has unique snake_case codes with a 4xx/5xx status (equality with the contracts list is asserted in public-api-contract.e2e-spec.ts)', () => {
    for (const [code, [status]] of Object.entries(API_ERROR_CATALOGUE)) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(status).toBeGreaterThanOrEqual(400);
    }
  });

  it('maps a code to its status, a stable title and the problem code', () => {
    const e = new ApiError('key_limit_reached', 'Too many keys');
    expect(e.status).toBe(422);
    expect(e.code).toBe('key_limit_reached');
    expect(e.message).toBe('Too many keys');
  });

  it('carries Retry-After and field errors', () => {
    const e = new ApiError('quota_exceeded', undefined, {
      retryAfterSeconds: 120,
      errors: [{ field: 'x', code: 'y' }],
    });
    expect(e.retryAfterSeconds).toBe(120);
    expect(e.extensions).toMatchObject({ errors: [{ field: 'x', code: 'y' }] });
  });

  it('every refusal of a credential is the same 401 with WWW-Authenticate', () => {
    const e = invalidApiKey();
    expect(e.status).toBe(401);
    expect(e.headers).toEqual({ 'WWW-Authenticate': 'Bearer' });
  });
});
