/** What the widget checkout application learns from `identify`; a failure keeps its status only (the text is the app's own). */
export type IdentifyResult =
  | { ok: true; widgetToken: string; customer: { id: string; email: string | null } }
  | { ok: false; status: number };

/**
 * The shape of `widgetIdentifySchema` (packages/contracts), checked by hand so the widget bundle does not carry a schema
 * library; `lib/api/widget.test.ts` runs both on the same bodies so they cannot drift apart.
 */
export function readIdentified(body: unknown): { widgetToken: string; customer: { id: string; email: string | null } } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { widgetToken, customer } = body as { widgetToken?: unknown; customer?: unknown };
  if (typeof widgetToken !== 'string' || widgetToken === '') return null;
  if (typeof customer !== 'object' || customer === null) return null;
  const { id, email } = customer as { id?: unknown; email?: unknown };
  if (typeof id !== 'string' || (email !== null && typeof email !== 'string')) return null;
  return { widgetToken, customer: { id, email } };
}

/**
 * S44 `POST /api/widget/v1/identify`: exchanges the host page's hand-off token for a widget session. Relative to the
 * document that runs the application (the embed document), no cookies, no credentials. The widget token is returned to
 * the caller to hold in memory; nothing here stores it.
 */
export async function identify(key: string, token: string): Promise<IdentifyResult> {
  let response: Response;
  try {
    response = await fetch('/api/widget/v1/identify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ key, token }),
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch {
    return { ok: false, status: 0 };
  }
  if (!response.ok) return { ok: false, status: response.status };
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, status: 502 };
  }
  const identified = readIdentified(body);
  return identified ? { ok: true, ...identified } : { ok: false, status: 502 };
}
