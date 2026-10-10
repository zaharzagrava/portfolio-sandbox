import { TcpFaultProxy } from '@app/test/fakes/tcp-fault-proxy';

/**
 * The only piece of the lib's spec kit that reaches into the e2e harness (`test/`): a pass-through TCP proxy in front
 * of the test Redis. Flip `mode` to refuse or hang the store for real (VII.9). Kept under `testing/`, where the
 * dependency rules allow it.
 */
export async function startStoreProxy(): Promise<TcpFaultProxy> {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6400/0');
  return TcpFaultProxy.start({
    host: url.hostname,
    port: Number(url.port || 6379),
  });
}

export const proxyUrl = (proxy: TcpFaultProxy): string =>
  `redis://127.0.0.1:${proxy.port}/0`;

export type { TcpFaultProxy };
