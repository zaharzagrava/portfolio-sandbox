/**
 * Human-readable message from a failed API call. The backend answers with RFC 7807 Problem Details
 * (`detail`, `title`); validation errors join field messages into `detail`. Falls back when the
 * request never reached the server (network error) or the body is not Problem Details.
 */
export function apiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object') {
    const body = data as { detail?: unknown; message?: unknown; title?: unknown };
    for (const value of [body.detail, body.message]) {
      if (typeof value === 'string' && value.trim()) return value;
      if (Array.isArray(value) && value.length) return value.join(', ');
    }
  }
  return fallback;
}
