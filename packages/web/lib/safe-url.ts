/**
 * A URL taken from a response (`imageUrl`, `urls`, `clickUrl`, `shortUrl`, `masterUrl`, `posterUrl`) is used only when it
 * is an absolute `https:` address without credentials; anything else is ignored (W02 AS-72). Returns the value
 * unchanged, or `undefined`.
 */
export function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return value;
  } catch {
    return undefined;
  }
}
