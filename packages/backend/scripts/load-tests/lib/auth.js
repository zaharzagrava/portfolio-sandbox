import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { urls } from './config.js';

const loginFailures = new Counter('auth_login_failures');

/** Logs in through the real auth endpoint - part of every flow's timing. */
export function login(email, password) {
  const res = http.post(
    `${urls.api}/api/auth/login`,
    JSON.stringify({ email, password }),
    {
      headers: { 'Content-Type': 'application/json' },
      tags: { name: 'POST /api/auth/login' },
    },
  );

  const ok = check(res, {
    'login: status 200': (r) => r.status === 200,
    'login: has access token': (r) => Boolean(safeJson(r, 'accessToken.token')),
  });

  if (!ok) {
    loginFailures.add(1);
    return null;
  }

  return {
    token: safeJson(res, 'accessToken.token'),
    user: safeJson(res, 'user'),
  };
}

export function authHeaders(token, extra = {}) {
  return { Authorization: `Bearer ${token}`, ...extra };
}

export function safeJson(res, selector) {
  try {
    return res.json(selector);
  } catch {
    return undefined;
  }
}
