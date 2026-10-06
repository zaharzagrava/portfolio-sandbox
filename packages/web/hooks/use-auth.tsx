'use client';

import { createContext, useContext, useEffect, useRef, useState, ReactNode } from 'react';
import { apiClient, refreshSession, setAccessToken } from '@/lib/api/client';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';

export type UserRole = 'USER' | 'SELLER' | 'ADMIN';

export interface User {
  id: string;
  email: string;
  /** Not provided by the API today; UI falls back to the email. */
  name?: string;
  role: UserRole;
  avatarUrl?: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** Returns `{ mfaRequired: true, mfaToken }` when a second factor is needed; otherwise the session is active. */
  login: (credentials: any) => Promise<{ mfaRequired: false } | { mfaRequired: true; mfaToken: string }>;
  verifyMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => Promise<void>;
  register: (data: any) => Promise<void>;
  /** Re-issues the access token (e.g. after opening a shop made the user a SELLER). */
  refreshSession: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();
  const queryClient = useQueryClient();

  // The refresh rotates the HttpOnly cookie and returns a new access token carrying the user's current role.
  const reissueSession = async () => {
    setUser((await refreshSession()).user as User);
  };

  // Bumped on every sign-in/out: a slower restore that started earlier must not overwrite a newer session.
  const sessionEpoch = useRef(0);

  useEffect(() => {
    // The access token lives in memory only; after a reload the HttpOnly refresh cookie restores the session.
    const epoch = sessionEpoch.current;
    refreshSession()
      .then((data) => {
        if (sessionEpoch.current === epoch) setUser(data.user as User);
      })
      .catch(() => {
        if (sessionEpoch.current === epoch) setUser(null);
      })
      .finally(() => setIsLoading(false));
  }, []);

  // A fresh sign-in: move the guest cart into the user's cart (checkout reads the user's cart), then drop
  // everything cached for the anonymous visitor.
  const acceptSession = async (data: { user: User; accessToken: { token: string } }) => {
    sessionEpoch.current++;
    setAccessToken(data.accessToken.token);
    setUser(data.user);
    await apiClient.post('/api/cart/merge', {}).catch(() => undefined);
    await queryClient.invalidateQueries();
  };

  // Navigation is the caller's job (returnUrl, MFA step).
  const login: AuthContextType['login'] = async (credentials) => {
    const { data } = await apiClient.post('/api/auth/login', { email: credentials.email, password: credentials.password });
    if (data.mfaRequired) return { mfaRequired: true, mfaToken: data.mfaToken };
    await acceptSession(data);
    return { mfaRequired: false };
  };

  const verifyMfa = async (mfaToken: string, code: string) => {
    const { data } = await apiClient.post('/api/auth/mfa/verify', { mfaToken, code });
    await acceptSession(data);
  };

  const logout = async () => {
    try {
      await apiClient.post('/api/auth/logout');
    } catch (e) {
      // Ignore failure on logout
    } finally {
      sessionEpoch.current++;
      setAccessToken(null);
      setUser(null);
      queryClient.clear();
      router.push('/login');
    }
  };

  // Register already opens a session (backend returns tokens + sets the refresh cookie).
  const register = async (input: any) => {
    const { data } = await apiClient.post('/api/auth/register', { email: input.email, password: input.password });
    await acceptSession(data);
  };

  const value = {
    user,
    isAuthenticated: !!user,
    isLoading,
    login,
    verifyMfa,
    logout,
    register,
    refreshSession: reissueSession,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
