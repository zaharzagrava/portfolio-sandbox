const MAX_LENGTH = 2048;
// C0 controls, DEL, C1 controls, and any whitespace (tab, newline and friends are stripped by URL parsers, which is how `/\t/evil` becomes `//evil`).
const FORBIDDEN = /[\u0000-\u001f\u007f-\u009f\s\\]/;

/**
 * A notification link is followed only when it is a same-site path (W03 FR-064, AS-63): it starts with exactly one `/`,
 * has no scheme, no `//`, no backslash and no control or whitespace character. Anything else is `null` and the item is
 * shown as plain text. The caller never builds an `href` from a link this function refused.
 */
export function safeNotificationLink(link: unknown): string | null {
  if (typeof link !== 'string' || link.length === 0 || link.length > MAX_LENGTH) return null;
  if (link[0] !== '/' || link[1] === '/') return null;
  if (FORBIDDEN.test(link)) return null;
  return link;
}
