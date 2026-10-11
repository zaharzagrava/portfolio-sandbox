import type { Response } from 'express';
import { BFF_COOKIES } from '@marketplace-sandbox/contracts';

/** The one place that knows cookie names and attributes (S48 FR-040, contracts/http.md). */
const MFA_PATH = '/'; // a `__Host-` cookie must have Path=/

const attributes = (
  path: string,
  maxAgeSeconds: number,
  extra: string[] = [],
): string =>
  [
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    `Path=${path}`,
    ...extra,
    'Secure',
    'SameSite=Lax',
  ].join('; ');

const append = (res: Response, line: string) => res.append('Set-Cookie', line);

export const sessionCookies = {
  /** `__Host-bff-session` (HttpOnly, opaque) and `__Host-bff-csrf` (readable by scripts), no `Domain`. */
  setSession(
    res: Response,
    sessionValue: string,
    csrfToken: string,
    maxAgeSeconds: number,
  ): void {
    append(
      res,
      `${BFF_COOKIES.session}=${sessionValue}; ${attributes('/', maxAgeSeconds, ['HttpOnly'])}`,
    );
    append(
      res,
      `${BFF_COOKIES.csrf}=${csrfToken}; ${attributes('/', maxAgeSeconds)}`,
    );
  },

  setCsrf(res: Response, csrfToken: string, maxAgeSeconds: number): void {
    append(
      res,
      `${BFF_COOKIES.csrf}=${csrfToken}; ${attributes('/', maxAgeSeconds)}`,
    );
  },

  /** The pending second-factor cookie lives five minutes and is only read by the session endpoints. */
  setMfa(res: Response, value: string, maxAgeSeconds: number): void {
    append(
      res,
      `${BFF_COOKIES.mfa}=${value}; ${attributes(MFA_PATH, maxAgeSeconds, ['HttpOnly'])}`,
    );
  },

  clearSession(res: Response): void {
    append(res, `${BFF_COOKIES.session}=; ${attributes('/', 0, ['HttpOnly'])}`);
    append(res, `${BFF_COOKIES.csrf}=; ${attributes('/', 0)}`);
  },

  clearMfa(res: Response): void {
    append(
      res,
      `${BFF_COOKIES.mfa}=; ${attributes(MFA_PATH, 0, ['HttpOnly'])}`,
    );
  },

  clearAll(res: Response): void {
    this.clearSession(res);
    this.clearMfa(res);
  },
};
