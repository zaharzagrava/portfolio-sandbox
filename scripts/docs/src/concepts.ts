import type { Graph, Unit } from './graph.ts';
import { bySort, slugify, uniq } from './util.ts';

/** A top-level topic proposed for a unit (the capability map). Deeper topics are discovered while pages are written. */
export interface TopicDef {
  slug: string;
  title: string;
  gist: string;
  files: string[];
  /** Slugs (same unit) this topic leans on. */
  uses: string[];
}

/** A piece a page names. Pieces that are not self-explanatory (`deeper`) become pages of their own, recursively. */
export interface PartDef {
  slug: string;
  title: string;
  what: string;
  files: string[];
  symbols: string[];
  deeper: boolean;
  /** Id of an existing concept to link instead of creating a new one. */
  reuse?: string;
}

export interface Concept {
  id: string;
  unit: Unit;
  slug: string;
  title: string;
  gist: string;
  /** Files this topic owns. Small terms own none and read their parent's. */
  files: string[];
  /** Files whose source is shown to the model when writing the page. */
  contextFiles: string[];
  symbols: string[];
  /** 0 = from the capability map; a part of a depth-n page is depth n+1 (edges only go deeper, so the graph is acyclic). */
  depth: number;
  parents: string[];
  children: string[];
  page: string;
  /** Capability-map `uses` (slugs), top-level only. */
  uses: string[];
  /** Existing top-level topics (other units too) this one imports from; the page picks the ones it really relies on. */
  candidates: string[];
}

export interface ConceptModel {
  concepts: Concept[];
  byId: Map<string, Concept>;
  /** file -> concepts that own it. */
  ownersOfFile: Map<string, string[]>;
  byUnit: Map<string, Concept[]>;
  warnings: string[];
}

export interface ModelLimits { maxUses: number; maxDepth: number; maxPerUnit: number }

export const capmapId = (u: Unit) => `capmap:${u.id}`;
export const conceptId = (u: Unit, slug: string) => `concept:${u.label}/${slug}`;
export const conceptPage = (u: Unit, slug: string) => `concepts/${slugify(u.label)}/${slug}.md`;

/**
 * The topic graph is a pure function of the capability maps and the pages written so far, so render/check/plan can
 * rebuild it from the cache. It grows one depth at a time: a page's `deeper` parts become the next depth's topics.
 */
export function buildConceptModel(graph: Graph, outputs: Map<string, any>, limits: ModelLimits): ConceptModel {
  const warnings: string[] = [];
  const concepts: Concept[] = [];
  const byId = new Map<string, Concept>();
  const byUnit = new Map<string, Concept[]>();
  const perUnit = new Map<string, number>();

  const add = (c: Omit<Concept, 'page' | 'children'>): Concept => {
    const full: Concept = { ...c, children: [], page: conceptPage(c.unit, c.slug) };
    concepts.push(full);
    byId.set(full.id, full);
    byUnit.set(c.unit.id, [...(byUnit.get(c.unit.id) ?? []), full]);
    perUnit.set(c.unit.id, (perUnit.get(c.unit.id) ?? 0) + 1);
    return full;
  };

  for (const unit of graph.units) {
    const defs: TopicDef[] | undefined = outputs.get(capmapId(unit))?.topics;
    for (const d of defs ?? []) add({ id: conceptId(unit, d.slug), unit, slug: d.slug, title: d.title, gist: d.gist, files: d.files, contextFiles: d.files, symbols: [], depth: 0, parents: [], uses: d.uses, candidates: [] });
  }

  for (let depth = 0; depth < limits.maxDepth; depth++) {
    const frontier = bySort(concepts.filter((c) => c.depth === depth), (c) => c.id);
    for (const parent of frontier) {
      for (const part of (outputs.get(parent.id)?.parts as PartDef[] | undefined) ?? []) {
        let target = part.reuse ? byId.get(part.reuse) : undefined;
        if (!target && part.deeper) {
          const id = conceptId(parent.unit, part.slug);
          target = byId.get(id);
          if (!target && (perUnit.get(parent.unit.id) ?? 0) < limits.maxPerUnit) {
            const own = part.files.length ? part.files : [];
            target = add({ id, unit: parent.unit, slug: part.slug, title: part.title, gist: part.what, files: own, contextFiles: own.length ? own : parent.contextFiles, symbols: part.symbols, depth: depth + 1, parents: [], uses: [], candidates: [] });
          } else if (!target) warnings.push(`${parent.id}: unit is at its ${limits.maxPerUnit}-topic cap, "${part.slug}" stays inline`);
        }
        // Structural edges only go deeper; anything else is a plain reference and cannot create a cycle.
        if (target && target.depth > parent.depth && target.id !== parent.id) {
          if (!target.parents.includes(parent.id)) target.parents.push(parent.id);
          if (!parent.children.includes(target.id)) parent.children.push(target.id);
        }
      }
    }
  }
  for (const c of concepts) {
    c.parents.sort();
    c.children.sort();
  }

  const ownersOfFile = new Map<string, string[]>();
  for (const c of concepts) for (const f of c.files) ownersOfFile.set(f, [...(ownersOfFile.get(f) ?? []), c.id]);

  // "Relies on" candidates: top-level topics owning files this topic's files import (barrels followed).
  const edgesFrom = new Map<string, { to: string; kind: string; typeOnly: boolean }[]>();
  for (const e of graph.edges) edgesFrom.set(e.from, [...(edgesFrom.get(e.from) ?? []), e]);
  const realTargets = (file: string, d = 0): string[] => {
    if (!graph.files.get(file)?.isBarrel || d > 5) return [file];
    const next = (edgesFrom.get(file) ?? []).filter((e) => e.kind === 'reexport').flatMap((e) => realTargets(e.to, d + 1));
    return next.length ? next : [file];
  };
  for (const c of concepts) {
    const mine = new Set(c.contextFiles);
    const counts = new Map<string, number>();
    for (const f of c.contextFiles) {
      for (const e of edgesFrom.get(f) ?? []) {
        if (e.typeOnly) continue;
        for (const t of realTargets(e.to)) {
          if (mine.has(t)) continue;
          for (const o of ownersOfFile.get(t) ?? []) if (o !== c.id && byId.get(o)!.depth === 0) counts.set(o, (counts.get(o) ?? 0) + 1);
        }
      }
    }
    const explicit = c.uses.map((s) => conceptId(c.unit, s)).filter((id) => byId.has(id) && id !== c.id);
    const derived = bySort([...counts], ([id, n]) => `${String(1e6 - n).padStart(7, '0')}${id}`).map(([id]) => id).slice(0, limits.maxUses);
    c.candidates = uniq([...explicit, ...derived]);
  }

  return { concepts: bySort(concepts, (c) => c.id), byId, ownersOfFile, byUnit, warnings };
}

/** Top-level topics that own a file (smallest first): the stable link target for "this file / symbol". */
export function topOwners(model: ConceptModel, file: string): Concept[] {
  const owners = (model.ownersOfFile.get(file) ?? []).map((id) => model.byId.get(id)!).filter((c) => c.depth === 0);
  return bySort(owners, (c) => `${String(c.files.length).padStart(6, '0')}${c.id}`);
}

/** Final "also relies on" edges of a page: what the model confirmed, always a subset of the candidates. */
export function conceptUses(c: Concept, out: any): { concept: string; how: string }[] {
  const ok = new Set(c.candidates);
  return ((out?.uses as { concept: string; how: string }[] | undefined) ?? []).filter((u) => ok.has(u.concept));
}

/** Resolves `{{slug}}` / `{{slug|text}}` / `{{concept-id}}` markers in model prose to links; unknown markers become plain text. */
export function resolveRefs(text: string, from: Concept, model: ConceptModel, parts: PartDef[], link: (c: Concept, label: string) => string): string {
  const partBySlug = new Map(parts.map((p) => [p.slug, p]));
  return text.replace(/\{\{([^}|]+?)(?:\|([^}]*))?\}\}/g, (_m, key: string, label?: string) => {
    const k = key.trim();
    const part = partBySlug.get(k);
    const target = (part?.reuse ? model.byId.get(part.reuse) : undefined) ?? (k.startsWith('concept:') ? model.byId.get(k) : model.byId.get(conceptId(from.unit, k)));
    const text = (label ?? '').trim() || part?.title || target?.title || k;
    return target && target.id !== from.id ? link(target, text) : text;
  });
}
