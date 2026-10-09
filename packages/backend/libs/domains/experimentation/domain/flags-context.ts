import type { EvalContext } from './evaluator';

/** Evaluation context from an HTTP request: identity, tenant, and edge-provided geography. */
export function contextFromRequest(req: {
  user?: { id: string; email?: string; role?: string };
  shopId?: string;
  headers: Record<string, string | string[] | undefined>;
}): EvalContext {
  const header = (name: string) => {
    const v = req.headers[name];
    return Array.isArray(v) ? v[0] : v;
  };
  return {
    userId: req.user?.id ?? header('x-anonymous-id'),
    shopId: req.shopId,
    role: req.user?.role,
    email_domain: req.user?.email?.split('@')[1],
    country: header('cf-ipcountry'),
    platform: header('x-client-platform'),
  };
}
