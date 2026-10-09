import { DynamicModule, Module } from '@nestjs/common';

export interface ProblemCatalogEntry {
  code: string;
  status: number;
  title: string;
  detail: string;
  /** Domain or lib that owns the code; named in the startup error on a clash. */
  owner: string;
}

/** Process-wide registry of problem codes; a duplicate code with a different definition fails startup (S54 AS-12). */
const registry = new Map<string, ProblemCatalogEntry>();

export const problemCatalog = {
  register(entries: ProblemCatalogEntry[]): void {
    for (const e of entries) {
      const existing = registry.get(e.code);
      if (
        existing &&
        (existing.status !== e.status ||
          existing.title !== e.title ||
          existing.detail !== e.detail)
      ) {
        throw new Error(
          `Problem code "${e.code}" is defined twice with different definitions: owners "${existing.owner}" and "${e.owner}"`,
        );
      }
      registry.set(e.code, e);
    }
  },
  get: (code: string): ProblemCatalogEntry | undefined => registry.get(code),
  /** Test helper. */
  clear: (): void => registry.clear(),
};

@Module({})
export class ProblemCatalogModule {
  /** Registers at module-definition time, so a clash fails startup before the app listens. */
  static forFeature(entries: ProblemCatalogEntry[]): DynamicModule {
    problemCatalog.register(entries);
    return { module: ProblemCatalogModule };
  }
}
