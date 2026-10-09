import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import type { DiscoveryService } from '@nestjs/core';

export interface MetadataRoute<V> {
  method: string;
  matcher: RegExp;
  value: V;
}

const toArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? (value as string[])
    : [typeof value === 'string' ? value : ''];

/** `/orders/:id/lines` as a regex (`:param` → one segment, `*` → anything). */
function pathMatcher(path: string): RegExp {
  const normalised = `/${path.split('/').filter(Boolean).join('/')}`;
  const pattern = normalised
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? '[^/]+'
        : segment.startsWith('*')
          ? '.*'
          : segment.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${pattern}/?$`);
}

/**
 * Routes whose handler (or controller) carries decorator metadata `key`, found by walking the controllers once.
 * Used by middleware that runs before routing and therefore cannot read the handler: load shedding (priority) and the
 * security policy groups. A handler's value wins over its controller's. Routes with no value are left out.
 */
export function scanMetadataRoutes<V>(
  discovery: DiscoveryService,
  key: symbol,
): MetadataRoute<V>[] {
  const routes: MetadataRoute<V>[] = [];
  for (const wrapper of discovery.getControllers()) {
    const metatype = wrapper.metatype as
      (new (...args: never[]) => unknown) | null;
    if (!metatype?.prototype) continue;
    const controllerPaths = toArray(
      Reflect.getMetadata(PATH_METADATA, metatype),
    );
    const controllerValue = Reflect.getMetadata(key, metatype) as V | undefined;
    for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
      const handler = (metatype.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (verb === undefined) continue;
      const value =
        (Reflect.getMetadata(key, handler) as V | undefined) ?? controllerValue;
      if (value === undefined) continue;
      for (const base of controllerPaths) {
        for (const sub of toArray(
          Reflect.getMetadata(PATH_METADATA, handler),
        )) {
          routes.push({
            method: RequestMethod[verb],
            matcher: pathMatcher(`${base}/${sub}`),
            value,
          });
        }
      }
    }
  }
  return routes;
}

/** Every route of every controller (method and path matcher), for answering "which methods exist on this path". */
export function scanAllRoutes(
  discovery: DiscoveryService,
): MetadataRoute<true>[] {
  const routes: MetadataRoute<true>[] = [];
  for (const wrapper of discovery.getControllers()) {
    const metatype = wrapper.metatype as
      (new (...args: never[]) => unknown) | null;
    if (!metatype?.prototype) continue;
    const controllerPaths = toArray(
      Reflect.getMetadata(PATH_METADATA, metatype),
    );
    for (const name of Object.getOwnPropertyNames(metatype.prototype)) {
      const handler = (metatype.prototype as Record<string, unknown>)[name];
      if (typeof handler !== 'function') continue;
      const verb = Reflect.getMetadata(METHOD_METADATA, handler) as
        RequestMethod | undefined;
      if (verb === undefined) continue;
      for (const base of controllerPaths) {
        for (const sub of toArray(
          Reflect.getMetadata(PATH_METADATA, handler),
        )) {
          routes.push({
            method: RequestMethod[verb],
            matcher: pathMatcher(`${base}/${sub}`),
            value: true,
          });
        }
      }
    }
  }
  return routes;
}

/** First scanned route that matches; `prefix` is the app's global prefix (routes are declared without it). */
export function matchMetadataRoute<V>(
  routes: MetadataRoute<V>[],
  method: string,
  path: string,
  prefix = '',
): V | undefined {
  const bare =
    prefix && path.startsWith(prefix) ? path.slice(prefix.length) || '/' : path;
  const verb = method === 'HEAD' ? 'GET' : method;
  return routes.find(
    (route) =>
      (route.method === 'ALL' || route.method === verb) &&
      route.matcher.test(bare),
  )?.value;
}
