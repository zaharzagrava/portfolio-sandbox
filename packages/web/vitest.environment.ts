import { builtinEnvironments, type Environment } from 'vitest/environments';

/**
 * jsdom, but keeping Node's AbortController/AbortSignal: Node's fetch (which MSW intercepts) rejects the jsdom ones.
 * (Passing a Node signal to jsdom's `addEventListener` is not supported; the app does not do that.)
 */
const environment: Environment = {
  name: 'jsdom-node-abort',
  transformMode: 'web',
  async setup(global, options) {
    const AbortController = global.AbortController;
    const AbortSignal = global.AbortSignal;
    const result = await builtinEnvironments.jsdom.setup(global, options);
    for (const [key, value] of [
      ['AbortController', AbortController],
      ['AbortSignal', AbortSignal],
    ] as const) {
      Object.defineProperty(global, key, { value, configurable: true, writable: true });
    }
    return result;
  },
};

export default environment;
