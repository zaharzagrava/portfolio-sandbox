import 'server-only';
import { parseConfig } from './config-parse';

/** Parsed once per server process; a bad value fails the first request (and the build) naming the variable. */
export const config = parseConfig(process.env);
