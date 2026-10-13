/**
 * Text that came from outside (a provider's error message, a callback's detail) may quote the address it was about.
 * Before such text reaches a log line or a timeline detail it is stripped of anything that looks like an e-mail address,
 * a phone number or a token (FR-051, AS-85). The shared pino redaction works on key names and cannot see inside a
 * message, so this is applied where the text is built.
 */
export function scrub(text: string, max = 200): string {
  return text
    .replace(/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g, '[address]')
    .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[token]')
    .slice(0, max);
}
