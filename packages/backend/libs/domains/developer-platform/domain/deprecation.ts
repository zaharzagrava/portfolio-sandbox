export interface Brownout {
  from: string;
  to: string;
}

export interface DeprecationEntry {
  deprecatedAt: string;
  sunset: string;
  replacement: string;
  brownouts?: Brownout[];
  /** Security-driven removal: minimum window 30 days instead of 6 months (FR-031). */
  security?: boolean;
}

export const DEPRECATION_DOCS = 'https://docs.marketplace.dev/api/deprecations';

export type DeprecationWindow = 'live' | 'deprecated' | 'brownout' | 'retired';

/** Calendar rule is "6 months" (see `addMonthsUtc`); this is its lower bound in days. */
export const MIN_WINDOW_DAYS = 181;

function addMonthsUtc(iso: string, months: number): number {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.getTime();
}
export const MIN_SECURITY_WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** IMF-fixdate in UTC (RFC 9110 §5.6.7), e.g. `Thu, 01 Apr 2027 00:00:00 GMT`. */
export function httpDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${p(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT`;
}

export function deprecationHeaders(e: DeprecationEntry): {
  Deprecation: string;
  Sunset: string;
  Link: string;
} {
  return {
    Deprecation: `@${Math.floor(Date.parse(e.deprecatedAt) / 1000)}`,
    Sunset: httpDate(new Date(e.sunset)),
    Link: [
      `<${DEPRECATION_DOCS}>; rel="deprecation"; type="text/html"`,
      `<${e.replacement}>; rel="successor-version"`,
    ].join(', '),
  };
}

export function evaluateWindow(
  e: DeprecationEntry,
  now: Date,
): DeprecationWindow {
  const t = now.getTime();
  if (t < Date.parse(e.deprecatedAt)) return 'live';
  if (t >= Date.parse(e.sunset)) return 'retired';
  if (e.brownouts?.some((b) => t >= Date.parse(b.from) && t < Date.parse(b.to)))
    return 'brownout';
  return 'deprecated';
}

/** End of the brownout window containing `now`, for `Retry-After`. */
export function brownoutEnd(e: DeprecationEntry, now: Date): Date | undefined {
  const t = now.getTime();
  const b = e.brownouts?.find(
    (w) => t >= Date.parse(w.from) && t < Date.parse(w.to),
  );
  return b ? new Date(b.to) : undefined;
}

const templates = new Map<string, RegExp>();
const templateOf = (path: string): RegExp => {
  let re = templates.get(path);
  if (!re) {
    re = new RegExp(
      `^${path
        .split('/')
        .map((seg) =>
          seg.startsWith(':')
            ? '[^/]+'
            : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        )
        .join('/')}/?$`,
    );
    templates.set(path, re);
  }
  return re;
};

/** The registry entry of a request, found by method (`HEAD` is `GET`) and path template (`/v1/products/:id/stock`). */
export function matchRoute(
  method: string,
  rawPath: string,
  registry: Record<string, DeprecationEntry>,
): { key: string; path: string; entry: DeprecationEntry } | null {
  const path = rawPath.split('?')[0];
  const verb = method === 'HEAD' ? 'GET' : method;
  for (const [key, entry] of Object.entries(registry)) {
    const [m, template] = key.split(' ');
    if (m === verb && templateOf(template).test(path))
      return { key, path: template, entry };
  }
  return null;
}

/** Startup validation: sunset at least 6 months after deprecation (30 days with the explicit security flag). */
export function assertRegistryValid(
  registry: Record<string, DeprecationEntry>,
): void {
  for (const [key, e] of Object.entries(registry)) {
    const days = (Date.parse(e.sunset) - Date.parse(e.deprecatedAt)) / DAY_MS;
    if (e.security) {
      if (days < MIN_SECURITY_WINDOW_DAYS)
        throw new Error(
          `Deprecation "${key}": security removals need at least 30 days`,
        );
    } else if (Date.parse(e.sunset) < addMonthsUtc(e.deprecatedAt, 6)) {
      throw new Error(
        `Deprecation "${key}": sunset must be at least 6 months after deprecation`,
      );
    }
  }
}
