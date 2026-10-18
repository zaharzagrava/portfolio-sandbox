'use client';

import { useIsMutating, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Flag, FlagAuditPage, FlagInput, FlagPage, StaleFlags } from '@marketplace-sandbox/contracts';
import { archiveFlag, getFlag, getFlagHistory, getStaleFlags, killFlag, listFlags, restoreFlag, saveFlag } from '@/lib/api/admin-flags';
import { retryUnlessClientError } from '@/lib/api/orders';
import { queryKeys } from '@/lib/query-keys';

/**
 * The console's server data and writes (W06 FR-003). Admin reads are never stale (`staleTime: 0`) and refetch on focus: a kill
 * state 60 seconds old is not acceptable. A 4xx is not retried. Every successful write invalidates the whole `admin.flags`
 * prefix, which refetches the list, the stale report and the history that are on screen.
 */
const FRESH = { staleTime: 0, refetchOnWindowFocus: true, retry: retryUnlessClientError } as const;

export function useFlags(params: { status?: string; cursor?: string }, initialData?: FlagPage) {
  return useQuery({ queryKey: queryKeys.admin.flags.list(params), queryFn: () => listFlags(params), initialData, ...FRESH });
}

export function useFlag(key: string, initialData?: Flag) {
  return useQuery({ queryKey: queryKeys.admin.flags.detail(key), queryFn: () => getFlag(key), initialData, ...FRESH });
}

export function useFlagHistory(key: string, params: { cursor?: string }, initialData?: FlagAuditPage) {
  return useQuery({ queryKey: queryKeys.admin.flags.history(key, params), queryFn: () => getFlagHistory(key, params), initialData, ...FRESH });
}

export function useStaleFlags(params: { days: number }, initialData?: StaleFlags) {
  return useQuery({ queryKey: queryKeys.admin.flags.stale(params), queryFn: () => getStaleFlags(params), initialData, ...FRESH });
}

/** Create (`expectedVersion` 0) and update. The detail is set from the answer, then everything else is refetched. */
export function useSaveFlag(key: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.admin.flags.all,
    mutationFn: (input: FlagInput) => saveFlag(key, input),
    onSuccess: async (flag) => {
      queryClient.setQueryData(queryKeys.admin.flags.detail(key), flag);
      await queryClient.invalidateQueries({ queryKey: queryKeys.admin.flags.all });
    },
  });
}

function useLifecycle(key: string, call: (key: string) => Promise<void>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: queryKeys.admin.flags.all,
    mutationFn: () => call(key),
    // Never optimistic (FR-030): the state shown changes only from the refetch after the 204.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.flags.all }),
  });
}

export const useKillFlag = (key: string) => useLifecycle(key, killFlag);
export const useRestoreFlag = (key: string) => useLifecycle(key, restoreFlag);
export const useArchiveFlag = (key: string) => useLifecycle(key, archiveFlag);

/** `true` while any console write (save, kill, restore, archive) is in flight: every write control disables itself (W06 AS-39). */
export function useFlagWriteBusy(): boolean {
  return useIsMutating({ mutationKey: queryKeys.admin.flags.all }) > 0;
}

/** Refetch of one flag after a conflict, a killed or archived answer (the page shows the server's state again). */
export function useRefetchFlag(key: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: queryKeys.admin.flags.detail(key) });
}
