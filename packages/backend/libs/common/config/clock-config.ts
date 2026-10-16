import * as joi from 'joi';
import { ConfigRules, type RuleCheck } from './config-rules';

/**
 * Controllable clock switch (S54, J01 G-32): `CLOCK_CONTROL=enabled` turns on the admin clock routes and the shared
 * Redis offset. Any other value (or none) keeps the real clock and answers 404 on the routes.
 */
export const clockConfigKeys = {
  clock_control: {
    name: 'CLOCK_CONTROL',
    verify: joi.string().valid('enabled', 'disabled').optional().allow(''),
  },
};

/** The controllable clock is never allowed in production. */
export const clockControlRule: RuleCheck = (ctx) =>
  ctx.production && ctx.get('clock_control') === 'enabled'
    ? ['clock_control must not be enabled in production']
    : [];

ConfigRules.register({
  owner: 'clock',
  keys: ['clock_control'],
  validate: clockControlRule,
});
