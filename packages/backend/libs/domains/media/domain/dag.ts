/**
 * Task graph of the transcoding pipeline (S30 FR-020..FR-022, AS-16). Pure.
 *
 * Exports:
 *  - `TASK_STATUSES` / `TaskStatus`: closed union, mirrors the `VideoTask.status` CHECK.
 *  - `canTransitionTask(from, to)`: the task state machine of data-model.md.
 *  - `TaskNode {name, deps}`; `GraphError` (`reason`, `tasks` = the offending task names).
 *  - `topoSort(nodes)`: validates (duplicate name, self dependency, unknown dependency, cycle) and returns an order.
 *  - `readyTasks(nodes)`: names that are PENDING with every dependency DONE or SKIPPED.
 *  - `buildGraph(rungs)`: the graph stored after `probe`; `transcodeTask(rung)`, `parseRungTask(name)`,
 *    `isOptionalTask(name)`.
 */
export const TASK_STATUSES = [
  'PENDING',
  'QUEUED',
  'RUNNING',
  'DONE',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskNode {
  name: string;
  deps: string[];
}

/** PENDING→QUEUED, QUEUED→RUNNING, RUNNING→{DONE,QUEUED,FAILED,SKIPPED}, open→CANCELLED, FAILED|CANCELLED→PENDING. */
const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ['QUEUED', 'CANCELLED'],
  QUEUED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['DONE', 'QUEUED', 'FAILED', 'SKIPPED', 'CANCELLED'],
  DONE: [],
  FAILED: ['PENDING'],
  SKIPPED: [],
  CANCELLED: ['PENDING'],
};

export const canTransitionTask = (from: TaskStatus, to: TaskStatus): boolean =>
  TASK_TRANSITIONS[from].includes(to);

export type GraphErrorReason =
  'duplicate_name' | 'self_dependency' | 'unknown_dependency' | 'cycle';

/** Raised before anything is stored; `tasks` names the offending tasks. */
export class GraphError extends Error {
  constructor(
    readonly reason: GraphErrorReason,
    readonly tasks: string[],
    message: string,
  ) {
    super(message);
    this.name = 'GraphError';
  }
}

/** Kahn's algorithm: a valid topological order, or a `GraphError` naming the offending tasks. */
export function topoSort(nodes: TaskNode[]): string[] {
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.name))
      throw new GraphError(
        'duplicate_name',
        [n.name],
        `duplicate task name ${n.name}`,
      );
    seen.add(n.name);
  }
  for (const n of nodes) {
    if (n.deps.includes(n.name))
      throw new GraphError(
        'self_dependency',
        [n.name],
        `${n.name} depends on itself`,
      );
    for (const d of n.deps)
      if (!seen.has(d))
        throw new GraphError(
          'unknown_dependency',
          [n.name, d],
          `${n.name} depends on unknown task ${d}`,
        );
  }
  const deps = new Map(nodes.map((n) => [n.name, new Set(n.deps)]));
  const indegree = new Map(nodes.map((n) => [n.name, deps.get(n.name)!.size]));
  const dependents = new Map<string, string[]>(nodes.map((n) => [n.name, []]));
  for (const n of nodes)
    for (const d of deps.get(n.name)!) dependents.get(d)!.push(n.name);
  const queue = nodes
    .filter((n) => indegree.get(n.name) === 0)
    .map((n) => n.name)
    .sort();
  const order: string[] = [];
  while (queue.length) {
    const name = queue.shift()!;
    order.push(name);
    for (const next of dependents.get(name)!) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) {
    const placed = new Set(order);
    const stuck = nodes.map((n) => n.name).filter((n) => !placed.has(n));
    throw new GraphError('cycle', stuck, `cycle among: ${stuck.join(', ')}`);
  }
  return order;
}

/**
 * Names that can start now: PENDING with every dependency DONE or SKIPPED. A FAILED or CANCELLED dependency never
 * satisfies its dependents.
 */
export function readyTasks(
  nodes: (TaskNode & { status: TaskStatus })[],
): string[] {
  const finished = new Set(
    nodes
      .filter((n) => n.status === 'DONE' || n.status === 'SKIPPED')
      .map((n) => n.name),
  );
  return nodes
    .filter(
      (n) => n.status === 'PENDING' && n.deps.every((d) => finished.has(d)),
    )
    .map((n) => n.name);
}

export const TRANSCODE_PREFIX = 'transcode:';
export const transcodeTask = (rung: number): string =>
  `${TRANSCODE_PREFIX}${rung}`;

/** The rung of a `transcode:<rung>` task name, or null for any other name. */
export const parseRungTask = (name: string): number | null => {
  if (!name.startsWith(TRANSCODE_PREFIX)) return null;
  const rest = name.slice(TRANSCODE_PREFIX.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
};

/** Optional tasks give up as SKIPPED after their last attempt instead of failing the video (AS-28). */
export const isOptionalTask = (name: string): boolean => name === 'thumbnails';

/**
 * The graph stored after `probe` succeeded (R-6): probe → (poster ‖ thumbnails ‖ transcode:<rung>…) → package →
 * publish. `package` follows every rendition; `publish` follows package, poster and thumbnails.
 */
export function buildGraph(rungs: number[]): TaskNode[] {
  const transcodes = rungs.map((r) => ({
    name: transcodeTask(r),
    deps: ['probe'],
  }));
  return [
    { name: 'probe', deps: [] },
    { name: 'poster', deps: ['probe'] },
    { name: 'thumbnails', deps: ['probe'] },
    ...transcodes,
    { name: 'package', deps: transcodes.map((t) => t.name) },
    { name: 'publish', deps: ['package', 'poster', 'thumbnails'] },
  ];
}
