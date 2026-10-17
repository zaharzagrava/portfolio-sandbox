import { invalidCursor } from './errors';

/** Opaque keyset cursors (III.10): base64url of a small JSON; anything else is `400 invalid_cursor`. */
export interface FunctionCursor {
  createdAt: string;
  id: string;
}

const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export const encodeFunctionCursor = (c: FunctionCursor) => encode(c);
export const encodeVersionCursor = (version: number) => encode({ v: version });

function decode(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalidCursor();
  }
}

/** The database's own text form of a timestamp (microsecond precision survives; a JS Date would round it). */
const TIMESTAMP =
  /^\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(\.\d{1,6})?([+-]\d\d(:?\d\d)?|Z)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function decodeFunctionCursor(raw: string): FunctionCursor {
  const value = decode(raw) as Partial<FunctionCursor> | null;
  if (
    !value ||
    typeof value.createdAt !== 'string' ||
    !TIMESTAMP.test(value.createdAt) ||
    typeof value.id !== 'string' ||
    !UUID.test(value.id)
  )
    throw invalidCursor();
  return { createdAt: value.createdAt, id: value.id };
}

export function decodeVersionCursor(raw: string): number {
  const value = decode(raw) as { v?: unknown } | null;
  if (!value || !Number.isInteger(value.v) || (value.v as number) < 1)
    throw invalidCursor();
  return value.v as number;
}
