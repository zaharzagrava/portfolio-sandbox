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
  // J03: the read-only event tap of the journey control surface (`GET /api/admin/topics/:topic/messages`).
  event_tap: {
    name: 'EVENT_TAP',
    verify: joi.string().valid('enabled', 'disabled').optional().allow(''),
  },
};

/** The event tap is never allowed in production. */
export const eventTapRule: RuleCheck = (ctx) =>
  ctx.production && ctx.get('event_tap') === 'enabled'
    ? ['event_tap must not be enabled in production']
    : [];

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

ConfigRules.register({
  owner: 'event-tap',
  keys: ['event_tap'],
  validate: eventTapRule,
});
