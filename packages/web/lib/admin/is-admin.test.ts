import { describe, expect, it } from 'vitest';
import { isAdmin } from './is-admin';

const user = (role: 'USER' | 'SELLER' | 'MODERATOR' | 'ADMIN') => ({ id: 'u1', email: 'a@b.c', role });

describe('isAdmin', () => {
  it('W06 AS-66: only the ADMIN role is an admin', () => {
    expect(isAdmin(user('ADMIN'))).toBe(true);
    expect(isAdmin(user('USER'))).toBe(false);
    expect(isAdmin(user('SELLER'))).toBe(false);
    expect(isAdmin(user('MODERATOR'))).toBe(false);
    expect(isAdmin(null)).toBe(false);
  });
});
