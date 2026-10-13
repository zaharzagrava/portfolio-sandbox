import * as joi from 'joi';

/**
 * Validated settings of `marketing` share links (S37 G5, G21, AS-62). The three secrets and the public base are
 * required (no fallback to another secret or to the backend host); an invalid value fails startup naming the key,
 * never the value.
 */
export interface ShareLinksConfig {
  /** Key of the Feistel bijection and of list cursors; at least 32 bytes, distinct from every other secret. */
  share_link_code_key: string;
  /** Public short-link base, an absolute https URL (for example https://mkt.to). */
  share_link_base_url: string;
  /** Credential the edge worker presents with `x-edge-click-recorded`; at least 32 bytes. */
  share_link_edge_secret: string;
  /** Active, unexpired links one owner may hold. */
  share_link_max_per_owner: number;
  /** Comma-separated words no alias may be (added to the built-in list). */
  share_link_reserved_aliases: string;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

const secret = (name: string): Key => ({
  name,
  verify: joi
    .string()
    .custom((value: string, helpers) =>
      Buffer.byteLength(value) < 32 ? helpers.error('string.min') : value,
    )
    .required(),
});

export const shareLinksConfigKeys: Record<keyof ShareLinksConfig, Key> = {
  share_link_code_key: secret('SHARE_LINK_CODE_KEY'),
  share_link_edge_secret: secret('SHARE_LINK_EDGE_SECRET'),
  share_link_base_url: {
    name: 'SHARE_LINK_BASE_URL',
    verify: joi
      .string()
      .uri({ scheme: ['https'] })
      .required(),
  },
  share_link_max_per_owner: {
    name: 'SHARE_LINK_MAX_PER_OWNER',
    verify: joi.number().integer().min(1).max(1_000_000).required(),
    postProcess: ((v: unknown) =>
      v === undefined || v === '' ? 1_000 : Number(v)) as never,
  },
  share_link_reserved_aliases: {
    name: 'SHARE_LINK_RESERVED_ALIASES',
    verify: joi.string().allow('').required(),
    postProcess: ((v: unknown) => (typeof v === 'string' ? v : '')) as never,
  },
};
