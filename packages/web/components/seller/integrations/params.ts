import { readCursor } from '@/lib/seller/search-params';

/** The URL state of the integration page: the section, the status filter, the cursor and the open reconciliation report. */

export const INTEGRATION_TABS = ['quarantine', 'conflicts', 'reconciliations'] as const;
export type IntegrationTab = (typeof INTEGRATION_TABS)[number];

export type DetailParams = { tab: IntegrationTab; status?: string; cursor?: string; run?: string };

const QUARANTINE_STATUSES = ['OPEN', 'RESOLVED', 'DISMISSED'];
const CONFLICT_STATUSES = ['OPEN', 'DISMISSED'];

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readDetailParams(query: { get(name: string): string | null }): DetailParams {
  const rawTab = query.get('tab');
  const tab = (INTEGRATION_TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as IntegrationTab) : 'quarantine';
  const allowed = tab === 'quarantine' ? QUARANTINE_STATUSES : tab === 'conflicts' ? CONFLICT_STATUSES : [];
  const status = query.get('status') ?? undefined;
  const run = query.get('run') ?? undefined;
  return {
    tab,
    status: status && allowed.includes(status) ? status : undefined,
    cursor: readCursor(query.get('cursor') ?? undefined),
    run: run && ID.test(run) ? run : undefined,
  };
}

/** The address of a state: defaults are left out (the quarantine tab, the `OPEN` status). */
export function detailHref(pathname: string, next: Partial<DetailParams>): string {
  const query = new URLSearchParams();
  if (next.tab && next.tab !== 'quarantine') query.set('tab', next.tab);
  if (next.status && next.status !== 'OPEN') query.set('status', next.status);
  if (next.run) query.set('run', next.run);
  if (next.cursor) query.set('cursor', next.cursor);
  const text = query.toString();
  return text ? `${pathname}?${text}` : pathname;
}
