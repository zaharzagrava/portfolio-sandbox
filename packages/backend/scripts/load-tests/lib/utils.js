export function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

export function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

/** Time-ordered UUIDv7 (48-bit ms timestamp + random). */
export function uuidv7() {
  const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const ts = Date.now().toString(16).padStart(12, '0');
  const variant = ['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)];
  return `${ts.slice(0, 8)}-${ts.slice(8, 12)}-7${hex(3)}-${variant}${hex(3)}-${hex(12)}`;
}

export function toQueryString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}
