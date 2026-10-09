/**
 * Paths that are exempt from load shedding, access logs and request metrics: the probes and the metrics scrape.
 * One list for every consumer (S54 G-33), matched with or without the global `/api` prefix.
 */
export const EXEMPT_PATHS = [
  '/health/live',
  '/health/ready',
  '/health/startup',
  '/metrics',
] as const;

const PREFIXED = /^\/api(?=\/)/;

export const isExemptPath = (path: string): boolean => {
  const bare = path.replace(PREFIXED, '').split('?')[0];
  return (EXEMPT_PATHS as readonly string[]).includes(bare);
};
