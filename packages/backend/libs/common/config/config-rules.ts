/** Read access to the configuration values a rule looks at, plus whether the app runs in production. */
export interface RuleContext {
  get(key: string): unknown;
  production: boolean;
}

/** Returns one message per violation. A message names keys and the broken rule, never a value. */
export type RuleCheck = (ctx: RuleContext) => string[];

export interface ConfigRule {
  /** Capability or lib that owns the rule; prefixed to its messages. */
  owner: string;
  /** Keys the rule reads (documentation and tooling; the rule itself decides what is a violation). */
  keys: string[];
  validate: RuleCheck | RuleCheck[];
}

const isSet = (value: unknown): boolean =>
  value !== undefined && value !== null && value !== '';

/**
 * Capability-registered startup rules (FR-077). Each capability declares its own (paired secrets, HTTPS-only
 * redirect bases, distinct secrets ...) next to the keys it owns; the toolkit evaluates all of them once, reports
 * every violation together and never prints a value.
 */
export class ConfigRuleSet {
  private readonly rules: ConfigRule[] = [];

  register(rule: ConfigRule): void {
    this.rules.push(rule);
  }

  validate(
    values: Record<string, unknown>,
    options: { production: boolean },
  ): string[] {
    const ctx: RuleContext = {
      get: (key) => values[key],
      production: options.production,
    };
    const found: string[] = [];
    for (const rule of this.rules) {
      for (const check of Array.isArray(rule.validate)
        ? rule.validate
        : [rule.validate]) {
        for (const message of check(ctx))
          found.push(`[${rule.owner}] ${message}`);
      }
    }
    return found;
  }

  assertValid(
    values: Record<string, unknown>,
    options: { production: boolean },
  ): void {
    const violations = this.validate(values, options);
    if (violations.length > 0)
      throw new Error(`Config validation error: ${violations.join('; ')}`);
  }
}

/** The process-wide set every app evaluates at startup. */
export const ConfigRules = new ConfigRuleSet();

/** The keys must be all set or all unset (a client id without its secret). */
export const requireTogether =
  (keys: string[]): RuleCheck =>
  (ctx) => {
    const set = keys.filter((k) => isSet(ctx.get(k)));
    return set.length === 0 || set.length === keys.length
      ? []
      : [`${keys.join(', ')} must be set together`];
  };

/** A valid URL with the https scheme; `localhost` and loopback addresses may use http when `allowLocalhost`. */
export const httpsUrl =
  (
    key: string,
    { allowLocalhost = false }: { allowLocalhost?: boolean } = {},
  ): RuleCheck =>
  (ctx) => {
    const value = ctx.get(key);
    if (!isSet(value)) return [];
    let url: URL;
    try {
      url = new URL(String(value));
    } catch {
      return [`${key} must be a valid URL`];
    }
    const local =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]';
    if (
      url.protocol === 'https:' ||
      (allowLocalhost && local && url.protocol === 'http:')
    )
      return [];
    return [
      `${key} must use https${allowLocalhost ? ' (http only for localhost)' : ''}`,
    ];
  };

const originOf = (value: unknown): string | undefined => {
  try {
    return isSet(value) ? new URL(String(value)).origin : undefined;
  } catch {
    return undefined;
  }
};

/** In production two origin-valued keys must not name the same origin (user content must not share the app origin). */
export const originsDiffer =
  (a: string, b: string): RuleCheck =>
  (ctx) => {
    if (!ctx.production) return [];
    const oa = originOf(ctx.get(a));
    return oa !== undefined && oa === originOf(ctx.get(b))
      ? [`${a} must differ from ${b} (same origin)`]
      : [];
  };

/** Secrets that are set must not repeat one another. */
export const distinctSecrets =
  (keys: string[]): RuleCheck =>
  (ctx) => {
    const byValue = new Map<string, string[]>();
    for (const key of keys) {
      const value = ctx.get(key);
      if (isSet(value))
        byValue.set(String(value), [
          ...(byValue.get(String(value)) ?? []),
          key,
        ]);
    }
    return [...byValue.values()]
      .filter((group) => group.length > 1)
      .map((group) => `${group.join(', ')} must not share a value`);
  };

/** In production a secret that is set must have at least `min` characters. */
export const minSecretLength =
  (key: string, min: number): RuleCheck =>
  (ctx) => {
    const value = ctx.get(key);
    return ctx.production && isSet(value) && String(value).length < min
      ? [`${key} must be at least ${min} characters`]
      : [];
  };

/** Read side of the platform configuration other capabilities use instead of reading raw keys. */
export class PlatformSettings {
  constructor(private readonly config: { get(key: string): unknown }) {}

  /** ISO 4217 code of the platform currency; `USD` when unset outside production. */
  get currency(): string {
    const value = this.config.get('platform_currency');
    return isSet(value) ? String(value) : 'USD';
  }

  get appOrigin(): string | undefined {
    return originOf(this.config.get('front_host'));
  }

  get usercontentOrigin(): string | undefined {
    return originOf(this.config.get('usercontent_origin'));
  }
}

const number = (ctx: RuleContext, key: string): number | undefined => {
  const value = ctx.get(key);
  return isSet(value) && Number.isFinite(Number(value))
    ? Number(value)
    : undefined;
};

const currencyRule: RuleCheck = (ctx) => {
  const value = ctx.get('platform_currency');
  if (value === undefined)
    return ctx.production
      ? ['platform_currency is required in production']
      : [];
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value)
    ? []
    : ['platform_currency must be an ISO 4217 code of three uppercase letters'];
};

/** `db_pool_max x db_max_instances (+ replica pool) <= db_connection_limit - db_reserved_connections` (constitution III.12). */
const poolArithmeticRule: RuleCheck = (ctx) => {
  const pool = number(ctx, 'db_pool_max');
  const instances = number(ctx, 'db_max_instances');
  const limit = number(ctx, 'db_connection_limit');
  if (pool === undefined || instances === undefined || limit === undefined)
    return [];
  const perInstance = pool + (number(ctx, 'db_replica_pool_max') ?? 0);
  const available = limit - (number(ctx, 'db_reserved_connections') ?? 0);
  const needed = perInstance * instances;
  return needed > available
    ? [
        `db_pool_max × db_max_instances = ${perInstance} × ${instances} = ${needed} > ${available} (db_connection_limit − db_reserved_connections)`,
      ]
    : [];
};

/** Drain delay plus request drain must end before the hard timeout (defaults 5 s + 15 s < 25 s). */
const shutdownTimingRule: RuleCheck = (ctx) => {
  const drainDelay = number(ctx, 'shutdown_drain_delay_ms') ?? 5_000;
  const requestDrain = number(ctx, 'shutdown_request_drain_ms') ?? 15_000;
  const hard = number(ctx, 'shutdown_hard_timeout_ms') ?? 25_000;
  return drainDelay + requestDrain >= hard
    ? [
        'shutdown_drain_delay_ms + shutdown_request_drain_ms must be below shutdown_hard_timeout_ms',
      ]
    : [];
};

/** HTTP startup requirements in production: an explicit proxy trust setting and a CORS allowlist without a wildcard. */
export const httpProductionRule: RuleCheck = (ctx) => {
  if (!ctx.production) return [];
  const found: string[] = [];
  if (!isSet(ctx.get('trusted_proxies')))
    found.push(
      'trusted_proxies is required in production (use "none" to trust no forwarding header)',
    );
  const configured = ctx.get('cors_allowed_origins');
  const origins = (typeof configured === 'string' ? configured : '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (origins.length === 0)
    found.push(
      'cors_allowed_origins must list at least one origin in production',
    );
  else if (origins.includes('*'))
    found.push(
      'cors_allowed_origins must not contain "*" (credentials are allowed)',
    );
  return found;
};

/**
 * Google sign-in (S02 FR-040): a client id without its secret (or the reverse) and a redirect base that is not https
 * (outside localhost) refuse to start; with Google configured the redirect base is required (no silent fall-back to
 * the backend host).
 */
export const validateOidcConfig: RuleCheck = (ctx) => {
  const found = requireTogether([
    'google_oidc_client_id',
    'google_oidc_client_secret',
  ])(ctx);
  found.push(
    ...httpsUrl('auth_redirect_base_url', { allowLocalhost: true })(ctx),
  );
  if (
    isSet(ctx.get('google_oidc_client_id')) &&
    !isSet(ctx.get('auth_redirect_base_url'))
  )
    found.push(
      'auth_redirect_base_url is required when Google sign-in is configured',
    );
  return found;
};

/** Rules owned by the platform toolkit itself. */
export const platformRules: ConfigRule[] = [
  { owner: 'platform', keys: ['platform_currency'], validate: currencyRule },
  {
    owner: 'platform',
    keys: [
      'db_pool_max',
      'db_max_instances',
      'db_connection_limit',
      'db_reserved_connections',
      'db_replica_pool_max',
    ],
    validate: poolArithmeticRule,
  },
  {
    owner: 'platform',
    keys: [
      'shutdown_drain_delay_ms',
      'shutdown_request_drain_ms',
      'shutdown_hard_timeout_ms',
    ],
    validate: shutdownTimingRule,
  },
  {
    owner: 'platform',
    keys: ['trusted_proxies', 'cors_allowed_origins'],
    validate: httpProductionRule,
  },
  {
    owner: 'identity',
    keys: [
      'google_oidc_client_id',
      'google_oidc_client_secret',
      'auth_redirect_base_url',
    ],
    validate: validateOidcConfig,
  },
  {
    owner: 'platform',
    keys: ['usercontent_origin', 'front_host'],
    validate: [
      originsDiffer('usercontent_origin', 'front_host'),
      httpsUrl('usercontent_origin', { allowLocalhost: true }),
    ],
  },
];

platformRules.forEach((rule) => ConfigRules.register(rule));
