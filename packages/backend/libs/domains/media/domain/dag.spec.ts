import fc from 'fast-check';
import {
  buildGraph,
  canTransitionTask,
  GraphError,
  isOptionalTask,
  parseRungTask,
  readyTasks,
  TASK_STATUSES,
  topoSort,
  transcodeTask,
  type TaskNode,
  type TaskStatus,
} from './dag';

const withStatus = (
  nodes: TaskNode[],
  status: (name: string) => TaskStatus,
): (TaskNode & { status: TaskStatus })[] =>
  nodes.map((n) => ({ ...n, status: status(n.name) }));

describe('task graph', () => {
  it('S30 AS-16: probe is first, publish last, package follows every rendition', () => {
    const order = topoSort(buildGraph([240, 480, 720]));
    expect(order[0]).toBe('probe');
    expect(order.at(-1)).toBe('publish');
    for (const r of [240, 480, 720])
      expect(order.indexOf('package')).toBeGreaterThan(
        order.indexOf(transcodeTask(r)),
      );
    expect(order.indexOf('publish')).toBeGreaterThan(order.indexOf('poster'));
    expect(order.indexOf('publish')).toBeGreaterThan(
      order.indexOf('thumbnails'),
    );
  });

  it('S30 AS-16: the graph for N rungs has N+5 tasks with unique names', () => {
    const nodes = buildGraph([240, 480]);
    expect(nodes.map((n) => n.name).sort()).toEqual(
      [
        'package',
        'poster',
        'probe',
        'publish',
        'thumbnails',
        'transcode:240',
        'transcode:480',
      ].sort(),
    );
  });

  it('S30 AS-16: a cycle is rejected and the error names the tasks', () => {
    const run = () =>
      topoSort([
        { name: 'a', deps: ['b'] },
        { name: 'b', deps: ['a'] },
        { name: 'c', deps: [] },
      ]);
    expect(run).toThrow(GraphError);
    expect(run).toThrow(/cycle/);
    try {
      run();
    } catch (e) {
      expect((e as GraphError).tasks.sort()).toEqual(['a', 'b']);
      expect((e as GraphError).reason).toBe('cycle');
    }
  });

  it('S30 AS-16: an unknown dependency is rejected, naming both tasks', () => {
    try {
      topoSort([{ name: 'a', deps: ['ghost'] }]);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphError);
      expect((e as GraphError).reason).toBe('unknown_dependency');
      expect((e as GraphError).tasks).toEqual(['a', 'ghost']);
      expect((e as Error).message).toContain('ghost');
    }
  });

  it('S30 AS-16: a duplicate task name is rejected', () => {
    try {
      topoSort([
        { name: 'a', deps: [] },
        { name: 'a', deps: [] },
      ]);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphError);
      expect((e as GraphError).reason).toBe('duplicate_name');
      expect((e as GraphError).tasks).toEqual(['a']);
    }
  });

  it('S30 AS-16: a self dependency is rejected', () => {
    try {
      topoSort([{ name: 'a', deps: ['a'] }]);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(GraphError);
      expect((e as GraphError).reason).toBe('self_dependency');
      expect((e as GraphError).tasks).toEqual(['a']);
    }
  });

  it('S30 AS-16: a repeated dependency does not break the order', () => {
    expect(
      topoSort([
        { name: 'a', deps: [] },
        { name: 'b', deps: ['a', 'a'] },
      ]),
    ).toEqual(['a', 'b']);
  });

  describe('readiness', () => {
    const nodes = buildGraph([240, 480]);

    it('S30 AS-22: after probe, poster + thumbnails + every rendition are ready together', () => {
      const s = withStatus(nodes, (n) => (n === 'probe' ? 'DONE' : 'PENDING'));
      expect(readyTasks(s).sort()).toEqual([
        'poster',
        'thumbnails',
        'transcode:240',
        'transcode:480',
      ]);
    });

    it('S30 AS-22: package waits for every rendition, publish for package, poster and thumbnails', () => {
      const partly = withStatus(nodes, (n) =>
        n === 'probe' || n === 'transcode:240' ? 'DONE' : 'PENDING',
      );
      expect(readyTasks(partly)).not.toContain('package');
      const renditionsDone = withStatus(nodes, (n) =>
        n.startsWith('transcode:') || n === 'probe' ? 'DONE' : 'PENDING',
      );
      expect(readyTasks(renditionsDone)).toContain('package');
      expect(readyTasks(renditionsDone)).not.toContain('publish');
    });

    it('S30 AS-28: SKIPPED satisfies a dependency (optional thumbnails gave up)', () => {
      const s = withStatus(nodes, (n) => {
        if (n === 'publish') return 'PENDING';
        return n === 'thumbnails' ? 'SKIPPED' : 'DONE';
      });
      expect(readyTasks(s)).toEqual(['publish']);
    });

    it.each(['FAILED', 'CANCELLED', 'PENDING', 'QUEUED', 'RUNNING'] as const)(
      'S30 AS-16: a %s dependency never satisfies its dependents',
      (blocked) => {
        const s = withStatus(nodes, (n) => {
          if (n === 'publish') return 'PENDING';
          return n === 'package' ? blocked : 'DONE';
        });
        expect(readyTasks(s)).not.toContain('publish');
      },
    );

    it.each([
      'QUEUED',
      'RUNNING',
      'DONE',
      'FAILED',
      'SKIPPED',
      'CANCELLED',
    ] as const)(
      'S30 AS-16: only PENDING tasks can be ready (%s is not)',
      (status) => {
        const s = withStatus(nodes, (n) =>
          n === 'probe' ? status : 'PENDING',
        );
        const ready = readyTasks(s);
        expect(ready).not.toContain('probe');
      },
    );
  });

  describe('task helpers', () => {
    it('S30 AS-16: transcode task names round-trip', () => {
      expect(transcodeTask(720)).toBe('transcode:720');
      expect(parseRungTask('transcode:720')).toBe(720);
      expect(parseRungTask('poster')).toBeNull();
      expect(parseRungTask('transcode:')).toBeNull();
      expect(parseRungTask('transcode:7x')).toBeNull();
    });

    it('S30 AS-28: only thumbnails is optional', () => {
      expect(isOptionalTask('thumbnails')).toBe(true);
      for (const t of [
        'probe',
        'poster',
        'transcode:240',
        'package',
        'publish',
      ])
        expect(isOptionalTask(t)).toBe(false);
    });
  });

  describe('task status transitions', () => {
    const LEGAL: [TaskStatus, TaskStatus][] = [
      ['PENDING', 'QUEUED'],
      ['QUEUED', 'RUNNING'],
      ['RUNNING', 'DONE'],
      ['RUNNING', 'QUEUED'],
      ['RUNNING', 'FAILED'],
      ['RUNNING', 'SKIPPED'],
      ['PENDING', 'CANCELLED'],
      ['QUEUED', 'CANCELLED'],
      ['RUNNING', 'CANCELLED'],
      ['FAILED', 'PENDING'],
      ['CANCELLED', 'PENDING'],
    ];
    const legal = new Set(LEGAL.map(([a, b]) => `${a}>${b}`));
    const pairs = TASK_STATUSES.flatMap((a) =>
      TASK_STATUSES.map((b) => [a, b] as const),
    );

    it('S30 FR-022: seven task statuses', () => {
      expect([...TASK_STATUSES]).toEqual([
        'PENDING',
        'QUEUED',
        'RUNNING',
        'DONE',
        'FAILED',
        'SKIPPED',
        'CANCELLED',
      ]);
    });

    it.each(pairs)('S30 FR-022: task %s -> %s', (from, to) => {
      expect(canTransitionTask(from, to)).toBe(legal.has(`${from}>${to}`));
    });
  });

  describe('properties', () => {
    /** Random acyclic graph: node i may only depend on nodes with a smaller index. */
    const acyclic = fc
      .integer({ min: 1, max: 14 })
      .chain((n) =>
        fc.tuple(
          ...Array.from({ length: n }, (_, i) =>
            i === 0
              ? fc.constant<number[]>([])
              : fc.uniqueArray(fc.integer({ min: 0, max: i - 1 }), {
                  maxLength: 5,
                }),
          ),
        ),
      )
      .map((deps) =>
        deps.map((d, i) => ({ name: `t${i}`, deps: d.map((x) => `t${x}`) })),
      );

    it('S30 AS-16: any acyclic graph sorts with every dependency before its dependent', () => {
      fc.assert(
        fc.property(acyclic, fc.integer(), (nodes, seed) => {
          // shuffle the input so the order cannot come from the input order
          const shuffled = [...nodes].sort(
            (a, b) =>
              ((a.name.charCodeAt(1) * 31 + seed) % 7) -
              ((b.name.charCodeAt(1) * 31 + seed) % 7),
          );
          const order = topoSort(shuffled);
          expect(order).toHaveLength(nodes.length);
          expect(new Set(order).size).toBe(nodes.length);
          const pos = new Map(order.map((n, i) => [n, i]));
          for (const n of nodes)
            for (const d of n.deps)
              expect(pos.get(d)!).toBeLessThan(pos.get(n.name)!);
        }),
        { numRuns: 200 },
      );
    });

    it('S30 AS-16: one back edge added to an acyclic graph is always detected', () => {
      fc.assert(
        fc.property(
          acyclic.filter((g) => g.length >= 2),
          fc.nat(),
          fc.nat(),
          (nodes, a, b) => {
            // pick i < j, make t_i depend on t_j; if t_j already (transitively) leads to t_i by
            // construction j > i means t_j may depend on t_i only through its deps: add the
            // direct edge t_j -> t_i as well so a cycle certainly exists.
            const i = a % (nodes.length - 1);
            const j = i + 1 + (b % (nodes.length - 1 - i));
            const cyclic = nodes.map((n) => {
              if (n.name === `t${i}`)
                return { ...n, deps: [...n.deps, `t${j}`] };
              if (n.name === `t${j}`)
                return { ...n, deps: [...n.deps, `t${i}`] };
              return n;
            });
            expect(() => topoSort(cyclic)).toThrow(GraphError);
          },
        ),
        { numRuns: 200 },
      );
    });

    it('S30 AS-16: the cycle error names only tasks that are on or behind the cycle', () => {
      fc.assert(
        fc.property(acyclic, (nodes) => {
          const names = new Set(nodes.map((n) => n.name));
          const withCycle = [
            ...nodes,
            { name: 'x', deps: ['y'] },
            { name: 'y', deps: ['x'] },
          ];
          try {
            topoSort(withCycle);
            throw new Error('should have thrown');
          } catch (e) {
            expect(e).toBeInstanceOf(GraphError);
            const named = (e as GraphError).tasks;
            expect(named).toEqual(expect.arrayContaining(['x', 'y']));
            for (const t of named) expect(names.has(t)).toBe(false);
          }
        }),
        { numRuns: 100 },
      );
    });
  });
});
