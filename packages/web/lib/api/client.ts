import axios, { AxiosError, InternalAxiosRequestConfig } from 'axios';

const baseURL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

export const apiClient = axios.create({
  baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,
});

let accessToken: string | null = null;
let isRefreshing = false;
let failedQueue: Array<{
  resolve: (token: string) => void;
  reject: (err: any) => void;
}> = [];

export const setAccessToken = (token: string | null) => {
  accessToken = token;
};

export const getAccessToken = () => accessToken;

/**
 * Double-submit CSRF: the backend sets a readable `__Host-csrf` cookie next to the HttpOnly refresh cookie and
 * expects it echoed in `x-csrf-token` on cookie-authenticated calls (refresh, logout).
 */
export function csrfHeaders(): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const match = document.cookie.match(/(?:^|;\s*)__Host-csrf=([^;]+)/);
  return match ? { 'x-csrf-token': decodeURIComponent(match[1]) } : {};
}

const processQueue = (error: any, token: string | null = null) => {
  failedQueue.forEach((prom) => {
    if (error) {
      prom.reject(error);
    } else if (token) {
      prom.resolve(token);
    }
  });

  failedQueue = [];
};

apiClient.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  if (accessToken && config.headers) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  if (config.headers && config.method && config.method.toLowerCase() !== 'get') {
    for (const [k, v] of Object.entries(csrfHeaders())) config.headers[k] = v;
  }
  return config;
});

export interface RefreshedSession {
  accessToken: { token: string; expiresIn: number };
  user: { id: string; email: string; role: string };
}

let refreshInFlight: Promise<RefreshedSession> | null = null;

/**
 * Rotates the refresh cookie and stores the new access token. Single-flight: refresh tokens are one-time-use and
 * the server treats a second use as theft (revoking the whole session), so concurrent callers - React StrictMode's
 * double effects, several 401s at once - must share one request.
 */
export function refreshSession(): Promise<RefreshedSession> {
  refreshInFlight ??= axios
    .post<RefreshedSession>(`${baseURL}/api/auth/refresh`, {}, { withCredentials: true, headers: csrfHeaders() })
    .then(({ data }) => {
      setAccessToken(data.accessToken.token);
      return data;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // Auth endpoints answer 401 for wrong credentials / no session: never try to refresh those.
    const isAuthCall = /\/api\/auth\/(refresh|login|register|mfa)/.test(originalRequest?.url ?? '');
    if (error.response?.status === 401 && originalRequest && !originalRequest._retry && !isAuthCall) {
      if (isRefreshing) {
        return new Promise(function (resolve, reject) {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            if (originalRequest.headers) {
              originalRequest.headers.Authorization = `Bearer ${token}`;
            }
            return apiClient(originalRequest);
          })
          .catch((err) => {
            return Promise.reject(err);
          });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const newToken = (await refreshSession()).accessToken.token;
        
        processQueue(null, newToken);
        
        if (originalRequest.headers) {
          originalRequest.headers.Authorization = `Bearer ${newToken}`;
        }
        
        return apiClient(originalRequest);
      } catch (err) {
        processQueue(err, null);
        setAccessToken(null);
        // No hard redirect: anonymous visitors may browse public pages; protected screens redirect themselves.
        return Promise.reject(err);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);
