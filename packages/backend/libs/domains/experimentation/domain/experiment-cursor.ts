import { createHmac, timingSafeEqual } from 'node:crypto';
import { invalidCursor } from './experiment-errors';

/**
 * Keyset cursors of the experiment list (`{createdAt, key}`) and of an experiment's history (`{at, id}`), signed with a
 * subkey of the key the caller passes (`jwt_secret`; domain separation by the label) and bound to their scope
 * (`experiments`, or `history:<key>`), so a tampered or foreign cursor is refused (`400 invalid_cursor`), never followed.
 */
const subkey = (key: string) =>
  createHmac('sha256', key).update('experiments:cursor').digest();

const sign = (key: string, body: string) =>
  createHmac('sha256', subkey(key)).update(body).digest('base64url');

export function encodeCursor(
  key: string,
  scope: string,
  fields: Record<string, string>,
): string {
  const body = Buffer.from(JSON.stringify({ s: scope, f: fields })).toString(
    'base64url',
  );
  return `${body}.${sign(key, body)}`;
}

export function decodeCursor(
  key: string,
  scope: string,
  cursor: string,
  names: string[],
): Record<string, string> {
  const [body, signature, extra] = cursor.split('.');
  if (!body || !signature || extra !== undefined) throw invalidCursor();
  const expected = Buffer.from(sign(key, body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    throw invalidCursor();
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (parsed.s !== scope || typeof parsed.f !== 'object' || !parsed.f)
      throw invalidCursor();
    const fields: Record<string, string> = {};
    for (const name of names) {
      if (typeof parsed.f[name] !== 'string') throw invalidCursor();
      fields[name] = parsed.f[name];
    }
    return fields;
  } catch {
    throw invalidCursor();
  }
}
