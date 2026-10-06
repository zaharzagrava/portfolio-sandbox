export interface RobotsRules {
  allow: string[];
  disallow: string[];
  crawlDelaySec: number | null;
}

/**
 * robots.txt for our user agent (RFC 9309): the most specific matching group
 * (our UA token, else `*`); a path is allowed if the LONGEST matching rule is
 * an Allow (ties → Allow). `*` wildcards and `$` anchors supported.
 */
export function parseRobots(text: string, userAgent: string): RobotsRules {
  const groups: { agents: string[]; rules: RobotsRules }[] = [];
  let current: { agents: string[]; rules: RobotsRules } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, field, value] = [m[0], m[1].toLowerCase(), m[2].trim()];
    if (field === 'user-agent') {
      if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: { allow: [], disallow: [], crawlDelaySec: null } }));
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (field === 'allow' && value) current.rules.allow.push(value);
    if (field === 'disallow' && value) current.rules.disallow.push(value);
    if (field === 'crawl-delay' && !Number.isNaN(Number(value))) current.rules.crawlDelaySec = Number(value);
  }
  const token = userAgent.toLowerCase().split('/')[0];
  return (groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a))) ?? groups.find((g) => g.agents.includes('*')))?.rules ?? { allow: [], disallow: [], crawlDelaySec: null };
}

function matchLength(pattern: string, path: string): number {
  const anchored = pattern.endsWith('$');
  const regex = new RegExp(`^${pattern.replace(/\$$/, '').replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}${anchored ? '$' : ''}`);
  return regex.test(path) ? pattern.length : -1;
}

export function isAllowed(rules: RobotsRules, path: string): boolean {
  const best = (patterns: string[]) => Math.max(-1, ...patterns.map((p) => matchLength(p, path)));
  return best(rules.allow) >= best(rules.disallow);
}
