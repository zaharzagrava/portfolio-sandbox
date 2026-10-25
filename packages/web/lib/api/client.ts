import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { endSession } from '@/lib/auth/session-ended';
import { csrfHeaders, hasCsrfCookie } from './csrf';
import { believesSignedIn } from './session-presence';

declare module 'axios' {
  interface AxiosRequestConfig {
    /** Anonymous flows (register, password reset) carry no CSRF proof (W01 AS-28). */
    anonymous?: boolean;
  }
}

/**
 * The shared browser client (W01 A1-A5): same-origin relative URLs only (`connect-src 'self'`; the `__Host-` cookies are
 * valid on one origin), the HttpOnly BFF session cookie travels by itself, and the CSRF proof is echoed on every
 * non-GET. There is no token state, no bearer header and no refresh here: the BFF attaches identity and
 * refreshes server-side.
 */
/** Longest wait for an answer from the API before the call is given up (the seller screens then say it could not be reached). */
export const REQUEST_TIMEOUT_MS = 15_000;

export const apiClient = axios.create({
  baseURL: '',
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,
  // No spinner may outlast a frozen database, cache or queue: a call with no answer ends as a network problem ("Couldn't reach the server", try again).
  timeout: REQUEST_TIMEOUT_MS,
});

const SAFE_METHODS = new Set(['get', 'head', 'options']);
const ENDED_CODES = new Set(['session_expired', 'unauthenticated', 'invalid_token']);

apiClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const method = (config.method ?? 'get').toLowerCase();
  if (SAFE_METHODS.has(method) || config.anonymous) return config;
  if (hasCsrfCookie()) {
    for (const [name, value] of Object.entries(csrfHeaders())) config.headers.set(name, value);
    return config;
  }
  if (believesSignedIn()) {
    // The proof is gone, so the session is too: do not send a request the BFF would refuse.
    endSession();
    return Promise.reject(new axios.AxiosError('csrf_missing', 'csrf_missing', config));
  }
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ code?: unknown }>) => {
    const code = error.response?.data?.code;
    if (error.response?.status === 401 && typeof code === 'string' && ENDED_CODES.has(code) && believesSignedIn()) {
      endSession();
    }
    return Promise.reject(error);
  },
);
