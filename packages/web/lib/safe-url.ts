/**
 * A URL taken from a response (`imageUrl`, `urls`, `clickUrl`, `shortUrl`, `masterUrl`, `posterUrl`) is used only when it
 * is an absolute `https:` address without credentials; anything else is ignored (W02 AS-72). Returns the value
 * unchanged, or `undefined`.
 */
export function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    // The dev stack serves media from the local MinIO over plain http (the same origin the CSP and the image allow-list name in development, B-002).
    const devMedia = process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && url.origin === 'http://localhost:9100';
    if (url.protocol !== 'https:' && !devMedia) return undefined;
    return value;
  } catch {
    return undefined;
  }
}
