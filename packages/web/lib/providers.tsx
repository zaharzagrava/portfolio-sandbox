'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import { useState, type ReactNode } from 'react';
import { OfflineNotice } from '@/components/layout/offline-notice';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { THEME_STORAGE_KEY } from '@/lib/browser-storage-keys';
import { z } from 'zod';

// zod probes `new Function('')` to decide whether to compile validators; under our CSP that probe is blocked and
// reported on every page. Interpreted validation is plenty for form-sized input.
z.config({ jitless: true });

/** `nonce` is this response's CSP nonce (read from the request in `components/layout/nonce-providers.tsx`). */
export function Providers({ children, nonce }: { children: ReactNode; nonce?: string }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 60s
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        disableTransitionOnChange
        storageKey={THEME_STORAGE_KEY}
        nonce={nonce}
      >
        <TooltipProvider>
          {children}
          <Toaster />
          <OfflineNotice />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
