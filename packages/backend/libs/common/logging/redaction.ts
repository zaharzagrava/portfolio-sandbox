export const REDACTED = '[REDACTED]';

/** Normalised key suffixes whose values are secrets or credentials: `clientSecret`, `refresh_token`, `x-api-key`, `Set-Cookie` ... */
const SECRET_SUFFIXES = [
  'password',
  'passwordhash',
  'token',
  'secret',
  'authorization',
  'cookie',
  'apikey',
  'cardnumber',
  'iban',
];

export const isSecretKey = (key: string): boolean => {
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_SUFFIXES.some((suffix) => normalised.endsWith(suffix));
};

const isPlain = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Copy of `value` with every secret-bearing key (by name, any depth, any case) replaced by `[REDACTED]` (FR-079).
 * Only plain objects and arrays are walked: class instances (requests, sockets, errors) are left to their serializers.
 * Cycles become `[Circular]`. Pure; the input is never mutated.
 */
export function redact(value: unknown): unknown {
  return walk(value, new WeakSet());
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const copy = value.map((item) => walk(item, seen));
    seen.delete(value);
    return copy;
  }
  if (!isPlain(value)) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const copy: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value))
    copy[key] = isSecretKey(key) ? REDACTED : walk(inner, seen);
  seen.delete(value);
  return copy;
}
