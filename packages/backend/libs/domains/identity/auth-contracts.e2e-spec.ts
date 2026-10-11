import {
  mfaCodeRequestSchema,
  passwordResetConfirmSchema,
  passwordResetRequestSchema,
  registerRequestSchema,
  sessionListItemSchema,
} from '@marketplace-sandbox/contracts';

const ok = (
  s: { safeParse: (v: unknown) => { success: boolean } },
  v: unknown,
) => s.safeParse(v).success;

describe('W01 auth contracts', () => {
  it('registerRequestSchema accepts email and password and refuses unknown members', () => {
    expect(ok(registerRequestSchema, { email: 'a@b.co', password: 'x' })).toBe(
      true,
    );
    expect(
      ok(registerRequestSchema, {
        email: 'a@b.co',
        password: 'x',
        role: 'ADMIN',
      }),
    ).toBe(false);
    expect(ok(registerRequestSchema, { email: 'a@b.co' })).toBe(false);
  });

  it('password reset schemas need an email, or a token and a password', () => {
    expect(ok(passwordResetRequestSchema, { email: 'a@b.co' })).toBe(true);
    expect(ok(passwordResetRequestSchema, {})).toBe(false);
    expect(ok(passwordResetConfirmSchema, { token: 't', password: 'p' })).toBe(
      true,
    );
    expect(ok(passwordResetConfirmSchema, { token: '', password: 'p' })).toBe(
      false,
    );
    expect(ok(passwordResetConfirmSchema, { token: 't' })).toBe(false);
  });

  it('sessionListItemSchema accepts nullable device, ip and lastUsedAt and refuses extra members', () => {
    const item = {
      sessionId: 's1',
      device: null,
      ip: '203.0.113.1',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: null,
      current: true,
    };
    expect(ok(sessionListItemSchema, item)).toBe(true);
    expect(ok(sessionListItemSchema, { ...item, current: 'yes' })).toBe(false);
    expect(ok(sessionListItemSchema, { ...item, refreshToken: 'x' })).toBe(
      false,
    );
  });

  it('mfaCodeRequestSchema accepts 1..64 characters and refuses empty, long or extra members', () => {
    expect(ok(mfaCodeRequestSchema, { code: '123456' })).toBe(true);
    expect(ok(mfaCodeRequestSchema, { code: 'a'.repeat(64) })).toBe(true);
    expect(ok(mfaCodeRequestSchema, { code: '' })).toBe(false);
    expect(ok(mfaCodeRequestSchema, { code: 'a'.repeat(65) })).toBe(false);
    expect(ok(mfaCodeRequestSchema, { code: '123456', extra: 1 })).toBe(false);
  });
});
