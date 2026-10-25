import { execFileSync } from 'node:child_process';

/**
 * Read-only SQL for the AI QA specs: the saved rows are read back from the dev stack's Postgres (the docker container of the
 * stack), never through the page. Returns the rows as arrays of text columns.
 */
const CONTAINER = process.env.AIQA_DB_CONTAINER ?? 'payment_system_db';

export function rows(sql: string): string[][] {
  const out = execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'marketplace', '-At', '-F', '\t', '-c', sql], { encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t'));
}

export const scalar = (sql: string): string => rows(sql)[0]?.[0] ?? '';

/** The id of the user with this email. */
export const userId = (email: string): string => scalar(`select id from "User" where email='${email.replace(/'/g, "''")}'`);

/** Moves one of the test's own shops to a status the screens cannot reach (SUSPENDED, DELETING, DELETED). */
export function setShopStatus(shopId: string, status: 'ACTIVE' | 'SUSPENDED' | 'DELETING' | 'DELETED'): void {
  execFileSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'marketplace', '-c', `update "Shop" set status='${status}' where id='${shopId}'`]);
}
