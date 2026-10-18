import { FLAG_KEY_PATTERN, FLAG_STATUSES } from '@marketplace-sandbox/contracts';

/** URL state of the console (W06 FR-001): one parser per page, and the same module builds the links. */
type Raw = string | string[] | undefined;
export type RawParams = Record<string, Raw>;

export const LIST_PATH = '/admin/feature-flags';
export const DEFAULT_STALE_DAYS = 14;
export const STALE_WINDOWS = [7, 14, 21, 30] as const;

export type ListStatus = 'all' | (typeof FLAG_STATUSES)[number];
export const LIST_STATUSES: readonly ListStatus[] = ['all', ...FLAG_STATUSES];

const single = (value: Raw): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export function parseListParams(params: RawParams): { status: ListStatus; cursor: string | undefined } {
  const status = single(params.status);
  return {
    status: (LIST_STATUSES as readonly string[]).includes(status ?? '') ? (status as ListStatus) : 'all',
    cursor: single(params.cursor),
  };
}

export function parseStaleParams(params: RawParams): { days: number } {
  const text = single(params.days);
  const days = text !== undefined && /^\d{1,2}$/.test(text) ? Number(text) : DEFAULT_STALE_DAYS;
  return { days: days >= 1 && days <= 30 ? days : DEFAULT_STALE_DAYS };
}

export function parseHistoryParams(params: RawParams): { cursor: string | undefined } {
  return { cursor: single(params.cursor) };
}

export type FlagTab = 'definition' | 'history';
export const parseFlagTab = (params: RawParams): FlagTab => (single(params.tab) === 'history' ? 'history' : 'definition');
export type ListTab = 'flags' | 'stale';
export const parseListTab = (params: RawParams): ListTab => (single(params.tab) === 'stale' ? 'stale' : 'flags');

function withQuery(path: string, entries: [string, string | undefined][]): string {
  const query = new URLSearchParams();
  for (const [name, value] of entries) if (value !== undefined) query.set(name, value);
  const text = query.toString().replace(/\+/g, '%20');
  return text ? `${path}?${text}` : path;
}

/** The list at a status (the default is not written); the cursor belongs to one status, so a new status passes none. */
export function listHref(params: { status: ListStatus; cursor?: string }): string {
  return withQuery(LIST_PATH, [
    ['status', params.status === 'all' ? undefined : params.status],
    ['cursor', params.cursor],
  ]);
}

export function staleHref(days: number): string {
  return withQuery(LIST_PATH, [
    ['tab', 'stale'],
    ['days', days === DEFAULT_STALE_DAYS ? undefined : String(days)],
  ]);
}

export const flagHref = (key: string) => `${LIST_PATH}/${encodeURIComponent(key)}`;
export const historyHref = (key: string, cursor?: string) => withQuery(flagHref(key), [['tab', 'history'], ['cursor', cursor]]);
export const NEW_FLAG_PATH = `${LIST_PATH}/new`;

export const isFlagKey = (key: string): boolean => FLAG_KEY_PATTERN.test(key);
