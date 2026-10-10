import { createHash } from 'node:crypto';
import { InvalidCursorError } from './job-errors';

/** Keyset position of the job list: `createdAt` as exact Postgres text (microseconds) plus the job id. */
export interface JobCursorPosition {
  createdAt: string;
  id: string;
}

const checksum = (body: string): string =>
  createHash('sha256').update(`jobs-cursor:${body}`).digest('hex').slice(0, 12);

/** Opaque, URL-safe, tamper-evident (a checksum, not a secret: the position it carries is not sensitive). */
export function encodeCursor(position: JobCursorPosition): string {
  const body = JSON.stringify([position.createdAt, position.id]);
  return Buffer.from(`${checksum(body)}.${body}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): JobCursorPosition {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const dot = text.indexOf('.');
    const body = text.slice(dot + 1);
    if (dot !== 12 || checksum(body) !== text.slice(0, dot))
      throw new InvalidCursorError();
    const parsed: unknown = JSON.parse(body);
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string'
    )
      throw new InvalidCursorError();
    return { createdAt: parsed[0], id: parsed[1] };
  } catch {
    throw new InvalidCursorError();
  }
}
