export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelaySec: number | null;
}

const MAX_ROBOTS_BYTES = 500 * 1024;
const MAX_CRAWL_DELAY_SEC = 300;
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

interface Group {
  agents: string[];
  rules: RobotsRules;
}

const emptyRules = (): RobotsRules => ({
  allow: [],
  disallow: [],
  crawlDelaySec: null,
});

/**
 * robots.txt for our user agent (RFC 9309): groups naming our product token
 * (exact, case-insensitive; never a substring) win over `*`; groups of the
 * same kind are merged. A path is allowed if the LONGEST matching rule is an
 * Allow (ties allow). `*` wildcards and `$` anchors supported. Only the first
 * 500 KiB are read.
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const bytes = Buffer.from(text, 'utf8');
  const bounded =
    bytes.length > MAX_ROBOTS_BYTES
      ? bytes.subarray(0, MAX_ROBOTS_BYTES).toString('utf8')
      : text;
  const unmarked = bounded.startsWith(BYTE_ORDER_MARK)
    ? bounded.slice(1)
    : bounded;
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of unmarked.split(/\r\n|\r|\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!current || !lastWasAgent)
        groups.push((current = { agents: [], rules: emptyRules() }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    const isPattern = value.startsWith('/') || value.startsWith('*');
    if (field === 'allow' && isPattern) current.rules.allow.push(value);
    else if (field === 'disallow' && isPattern)
      current.rules.disallow.push(value);
    else if (field === 'crawl-delay' && /^\d+(\.\d+)?$/.test(value)) {
      const delay = Number(value);
      if (Number.isFinite(delay)) current.rules.crawlDelaySec = delay;
    }
  }
  const token = userAgent.toLowerCase().split(/[/\s]/)[0];
  const ours = groups.filter((g) => g.agents.includes(token));
  const matched = ours.length
    ? ours
    : groups.filter((g) => g.agents.includes('*'));
  const merged = emptyRules();
  for (const g of matched) {
    merged.allow.push(...g.rules.allow);
    merged.disallow.push(...g.rules.disallow);
    merged.crawlDelaySec = g.rules.crawlDelaySec ?? merged.crawlDelaySec;
  }
  return merged;
}

/**
 * `*` matches any run of characters. A pattern matches a prefix of the path unless it is anchored with `$`. Iterative
 * (no backtracking regex), so a hostile robots.txt with many wildcards cannot stall the crawler.
 */
function globMatch(pattern: string, path: string, anchored: boolean): boolean {
  let i = 0;
  let j = 0;
  let starJ = -1;
  let starI = 0;
  while (i < path.length) {
    if (j === pattern.length && !anchored) return true;
    if (j < pattern.length && pattern[j] === '*') {
      starJ = j++;
      starI = i;
    } else if (j < pattern.length && pattern[j] === path[i]) {
      i++;
      j++;
    } else if (starJ >= 0) {
      j = starJ + 1;
      i = ++starI;
    } else return false;
  }
  while (j < pattern.length && pattern[j] === '*') j++;
  return j === pattern.length;
}

function matchLength(pattern: string, path: string): number {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  return globMatch(body, path, anchored) ? pattern.length : -1;
}

export function isAllowed(rules: RobotsRules, pathWithQuery: string): boolean {
  const best = (patterns: string[]) =>
    Math.max(-1, ...patterns.map((p) => matchLength(p, pathWithQuery)));
  return best(rules.allow) >= best(rules.disallow);
}

export function capCrawlDelayMs(rules: RobotsRules, minGapMs = 1000): number {
  const delaySec = Math.min(rules.crawlDelaySec ?? 0, MAX_CRAWL_DELAY_SEC);
  return Math.max(minGapMs, delaySec * 1000);
}
