// Runs in the browser before any application module: zod must be told not to probe `new Function('')` before the first
// schema is built (see lib/zod-jitless.ts), otherwise the strict CSP reports a violation on every page.
import '@/lib/zod-jitless';
