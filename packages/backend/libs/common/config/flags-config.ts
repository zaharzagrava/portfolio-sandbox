import * as joi from 'joi';

/**
 * Settings of `experimentation` flags (S38 R-14). The edge credential is optional and has no default: without it the
 * `country` header of a request is never trusted (IV.7). When set it is at least 32 bytes, so a short guess is refused at
 * startup, naming the key and never the value.
 */
export interface FlagsConfig {
  /** Credential the edge presents in `x-edge-credential` so its `cf-ipcountry` header is believed. */
  flags_edge_secret?: string;
}

type Key = {
  name: string;
  verify: joi.AnySchema;
  postProcess?: (v: unknown) => never;
};

export const flagsConfigKeys: Record<keyof FlagsConfig, Key> = {
  flags_edge_secret: {
    name: 'FLAGS_EDGE_SECRET',
    verify: joi
      .string()
      .custom((value: string, helpers) =>
        Buffer.byteLength(value) < 32 ? helpers.error('string.min') : value,
      )
      .optional()
      .empty(''),
  },
};
