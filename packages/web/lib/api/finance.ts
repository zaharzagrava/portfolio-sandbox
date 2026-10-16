'use client';

import { useQuery } from '@tanstack/react-query';
import {
  balanceSchema,
  payoutPageSchema,
  statementPageSchema,
  statementSchema,
  upcomingPayoutSchema,
  type Balance,
  type PayoutView,
  type Statement,
  type StatementPage,
  type UpcomingPayoutView,
} from '@marketplace-sandbox/contracts';
import { apiClient } from './client';
import { parseBody } from './parse';
import { retryUnlessClientError } from './orders';

export type { Balance, PayoutView, Statement, StatementPage, UpcomingPayoutView };

/** The ledger books in the platform currency; the balance route needs it named. */
export const LEDGER_CURRENCY = 'EUR';
const PAYOUTS_PAGE_SIZE = 20;
const STATEMENTS_PAGE_SIZE = 12;
const LIVE_REFRESH_MS = 15_000;

const shopPath = (shopId: string) => `/api/shops/${encodeURIComponent(shopId)}`;

export async function fetchBalance(shopId: string): Promise<Balance> {
  const { data } = await apiClient.get<unknown>(`${shopPath(shopId)}/balance`, { params: { currency: LEDGER_CURRENCY } });
  return parseBody(balanceSchema, data);
}

export async function fetchPayouts(shopId: string): Promise<{ items: PayoutView[]; nextCursor: string | null }> {
  const { data } = await apiClient.get<unknown>(`${shopPath(shopId)}/payouts`, { params: { limit: PAYOUTS_PAGE_SIZE } });
  return parseBody(payoutPageSchema, data);
}

export async function fetchUpcomingPayout(shopId: string): Promise<UpcomingPayoutView> {
  const { data } = await apiClient.get<unknown>(`${shopPath(shopId)}/payouts/upcoming`);
  return parseBody(upcomingPayoutSchema, data);
}

export async function fetchStatements(shopId: string): Promise<StatementPage> {
  const { data } = await apiClient.get<unknown>(`${shopPath(shopId)}/statements`, { params: { limit: STATEMENTS_PAGE_SIZE } });
  return parseBody(statementPageSchema, data);
}

/** `knownAt` (ISO date-time with offset) asks for the statement as it was known on that day; omitted it is the live one. */
export async function fetchStatement(shopId: string, month: string, knownAt?: string): Promise<Statement> {
  const { data } = await apiClient.get<unknown>(`${shopPath(shopId)}/statements/${encodeURIComponent(month)}`, {
    params: knownAt ? { knownAt } : undefined,
  });
  return parseBody(statementSchema, data);
}

/** End of the picked day in UTC, as the offset date-time the statement route validates. */
export function endOfDayKnownAt(day: string): string {
  return `${day}T23:59:59.999Z`;
}

export function statementCsvPath(shopId: string, month: string, knownAt?: string): string {
  const query = knownAt ? `?knownAt=${encodeURIComponent(knownAt)}` : '';
  return `${shopPath(shopId)}/statements/${encodeURIComponent(month)}/lines.csv${query}`;
}

export function useShopBalance(shopId: string) {
  return useQuery({
    queryKey: ['finance', shopId, 'balance'],
    queryFn: () => fetchBalance(shopId),
    retry: retryUnlessClientError,
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useShopPayouts(shopId: string) {
  return useQuery({
    queryKey: ['finance', shopId, 'payouts'],
    queryFn: () => fetchPayouts(shopId),
    retry: retryUnlessClientError,
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useUpcomingPayout(shopId: string) {
  return useQuery({
    queryKey: ['finance', shopId, 'payouts', 'upcoming'],
    queryFn: () => fetchUpcomingPayout(shopId),
    retry: retryUnlessClientError,
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useStatements(shopId: string) {
  return useQuery({
    queryKey: ['finance', shopId, 'statements'],
    queryFn: () => fetchStatements(shopId),
    retry: retryUnlessClientError,
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useStatement(shopId: string, month: string | undefined, knownAt: string | undefined) {
  return useQuery({
    queryKey: ['finance', shopId, 'statements', month, knownAt ?? 'live'],
    enabled: !!month,
    queryFn: () => fetchStatement(shopId, month as string, knownAt),
    retry: retryUnlessClientError,
  });
}
