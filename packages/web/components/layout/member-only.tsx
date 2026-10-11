'use client';

import type { ReactNode } from 'react';
import { useAuth } from '@/hooks/use-auth';

/** Renders its children for signed-in members only, so a visitor mounts (and requests) nothing. */
export function MemberOnly({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <>{children}</> : null;
}
