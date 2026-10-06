/**
 * Task DAG for the transcoding pipeline (10/08 #26). A real DAG, not a
 * script: renditions run in PARALLEL on different workers, `package` waits for
 * all of them, `publish` for package + poster, and a crash resumes from the
 * last completed node.
 */
export interface TaskNode {
  name: string;
  deps: string[];
}

export type TaskStatus = 'PENDING' | 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'SKIPPED';

/** Kahn's algorithm: a valid topological order, or an error naming the cycle's nodes. */
export function topoSort(nodes: TaskNode[]): string[] {
  const names = new Set(nodes.map((n) => n.name));
  for (const n of nodes) for (const d of n.deps) if (!names.has(d)) throw new Error(`${n.name} depends on unknown task ${d}`);
  const indegree = new Map(nodes.map((n) => [n.name, n.deps.length]));
  const dependents = new Map<string, string[]>(nodes.map((n) => [n.name, []]));
  for (const n of nodes) for (const d of n.deps) dependents.get(d)!.push(n.name);
  const queue = nodes.filter((n) => n.deps.length === 0).map((n) => n.name).sort();
  const order: string[] = [];
  while (queue.length) {
    const name = queue.shift()!;
    order.push(name);
    for (const next of dependents.get(name)!) {
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }
  if (order.length !== nodes.length) throw new Error(`cycle among: ${nodes.filter((n) => !order.includes(n.name)).map((n) => n.name).join(', ')}`);
  return order;
}

/** Nodes that can start now: PENDING with every dependency DONE or SKIPPED. */
export function readyTasks(nodes: (TaskNode & { status: TaskStatus })[]): string[] {
  const finished = new Set(nodes.filter((n) => n.status === 'DONE' || n.status === 'SKIPPED').map((n) => n.name));
  return nodes.filter((n) => n.status === 'PENDING' && n.deps.every((d) => finished.has(d))).map((n) => n.name);
}

/** The pipeline for one video: probe → (renditions ‖ poster) → package → publish. */
export function videoPipeline(renditions: string[]): TaskNode[] {
  const transcodes = renditions.map((r) => ({ name: `transcode:${r}`, deps: ['probe'] }));
  return [
    { name: 'probe', deps: [] },
    ...transcodes,
    { name: 'poster', deps: ['probe'] },
    { name: 'package', deps: transcodes.map((t) => t.name) },
    { name: 'publish', deps: ['package', 'poster'] },
  ];
}
