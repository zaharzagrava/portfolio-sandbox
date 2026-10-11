import { describe, expect, it } from 'vitest';
import { authPageRedirect } from './guards';

const user = { id: 'u1', email: 'a@b.co', role: 'USER' as const };

describe('authPageRedirect', () => {
  it.each([
    ['signed in with a safe returnTo', { user, returnTo: '/account/security?tab=methods' }, '/account/security?tab=methods'],
    ['signed in without returnTo', { user }, '/'],
    ['signed in with an unsafe returnTo', { user, returnTo: '//evil.example' }, '/'],
    ['signed in with a provider error', { user, error: 'link_conflict', returnTo: '/x' }, '/account/security?tab=methods&error=link_conflict'],
    ['signed in with an unknown error value', { user, error: 'whatever' }, '/'],
    ['anonymous', { user: null, returnTo: '/x' }, null],
    ['anonymous with an error', { user: null, error: 'oidc_denied' }, null],
  ])('W01 AS-16: %s', (_name, input, expected) => {
    expect(authPageRedirect(input)).toBe(expected);
  });
});
