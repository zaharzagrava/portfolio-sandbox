import { z } from 'zod';

/**
 * zod probes `new Function('')` to decide whether to compile validators; under our CSP that probe is blocked and reported
 * on every page. Interpreted validation is plenty for form-sized input. Import this before any module that builds a
 * schema at load time (the probe runs when the first object schema is created).
 */
z.config({ jitless: true });

export {};
