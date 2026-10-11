import { sessionResponseSchema } from '@marketplace-sandbox/contracts';

export type ServerSessionUser = { id: string; email: string; role: 'USER' | 'SELLER' | 'MODERATOR' | 'ADMIN' };

/**
 * Server-side read of the BFF session (W01 FR-005): forwards only the session cookie and returns the narrow
 * `{id, email, role}`, or `null` for anonymous and for any answer that is not a valid session. Never returns a token.
 */
export async function fetchServerSession(input: { bffUrl: string; cookieName: string; cookieValue: string }): Promise<ServerSessionUser | null> {
  try {
    const res = await fetch(`${input.bffUrl}/api/bff/session`, {
      headers: { cookie: `${input.cookieName}=${input.cookieValue}`, accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const parsed = sessionResponseSchema.safeParse(await res.json());
    if (!parsed.success) return null;
    const { id, email, role } = parsed.data.user;
    return { id, email: email ?? '', role };
  } catch {
    return null;
  }
}
