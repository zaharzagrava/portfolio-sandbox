import { acceptedSchema, registerRequestSchema } from '@marketplace-sandbox/contracts';
import { apiClient } from './client';
import { parseBody } from './parse';

/**
 * Anonymous account flows (no session yet, so no CSRF proof). Failures throw the axios error; screens convert it with
 * `problemFromError` and switch on `code`.
 */

/** `202` for new and existing addresses alike (S01 AS-02): the caller must not branch on anything else. */
export async function register(input: { email: string; password: string }): Promise<void> {
  const body = registerRequestSchema.parse({ email: input.email, password: input.password });
  const { data } = await apiClient.post('/api/auth/register', body, { anonymous: true });
  parseBody(acceptedSchema, data);
}

export async function requestPasswordReset(email: string): Promise<void> {
  const { data } = await apiClient.post('/api/auth/password-reset/request', { email }, { anonymous: true });
  parseBody(acceptedSchema, data);
}

export async function confirmPasswordReset(input: { token: string; password: string }): Promise<void> {
  await apiClient.post('/api/auth/password-reset/confirm', { token: input.token, password: input.password }, { anonymous: true });
}
