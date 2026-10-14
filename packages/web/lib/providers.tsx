'use client';

// These two must stay first: they configure libraries (sonner's style tag, zod's eval probe) that the modules below load.
import '@/lib/style-nonce';
import '@/lib/zod-jitless';
import { QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import type { ReactNode } from 'react';
import { SessionLifecycle } from '@/components/auth/session-lifecycle';
import { OfflineNotice } from '@/components/layout/offline-notice';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { THEME_STORAGE_KEY } from '@/lib/browser-storage-keys';
import { getQueryClient } from '@/lib/query-client';

/** `nonce` is this response's CSP nonce (read from the request in `components/layout/nonce-providers.tsx`). */
export function Providers({ children, nonce }: { children: ReactNode; nonce?: string }) {
  const queryClient = getQueryClient();

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
          <SessionLifecycle />
          {children}
          <Toaster />
          <OfflineNotice />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
