import {
  buildGraph,
  readyTasks,
  topoSort,
  type TaskNode,
  type TaskStatus,
} from './dag';
import { buildMasterPlaylist, ladderFor, type MeasuredRendition } from './hls';

/**
 * The pipeline model as a whole: the graph, the ladder and the master playlist working together on one video.
 * (The parts have their own specs: `dag.spec.ts`, `hls.spec.ts`; these three scenarios were the old `video.spec.ts`.)
 */
describe('video pipeline model', () => {
  const withStatus = (nodes: TaskNode[], done: string[]) =>
    nodes.map((n) => ({
      ...n,
      status: (done.includes(n.name) ? 'DONE' : 'PENDING') as TaskStatus,
    }));

  it('S30 AS-16: topological order puts probe first and publish last; cycles are rejected', () => {
    const nodes = buildGraph(ladderFor(1280, 720).map((r) => r.rung));
    const order = topoSort(nodes);
    expect(order[0]).toBe('probe');
    expect(order[order.length - 1]).toBe('publish');
    expect(order.indexOf('package')).toBeGreaterThan(
      order.indexOf('transcode:720'),
    );
    expect(() =>
      topoSort([
        { name: 'a', deps: ['b'] },
        { name: 'b', deps: ['a'] },
      ]),
    ).toThrow(/cycle/);
  });

  it('S30 AS-16: fan-out / fan-in: renditions and poster become ready together; package waits for every rendition', () => {
    const nodes = buildGraph([240, 480, 720]);
    expect(readyTasks(withStatus(nodes, []))).toEqual(['probe']);
    expect(readyTasks(withStatus(nodes, ['probe'])).sort()).toEqual(
      [
        'poster',
        'thumbnails',
        'transcode:240',
        'transcode:480',
        'transcode:720',
      ].sort(),
    );
    expect(
      readyTasks(
        withStatus(nodes, [
          'probe',
          'poster',
          'thumbnails',
          'transcode:240',
          'transcode:480',
        ]),
      ),
    ).toEqual(['transcode:720']);
    expect(
      readyTasks(
        withStatus(nodes, [
          'probe',
          'poster',
          'thumbnails',
          'transcode:240',
          'transcode:480',
          'transcode:720',
        ]),
      ),
    ).toEqual(['package']);
  });

  it('S30 AS-17: never upscales and writes a valid master playlist', () => {
    expect(ladderFor(640, 360).map((r) => r.height)).toEqual([240]);
    expect(ladderFor(1920, 1080).map((r) => r.height)).toEqual([
      240, 480, 720, 1080,
    ]);
    const measured: MeasuredRendition[] = ladderFor(1280, 720).map((r, i) => ({
      name: r.name,
      width: r.width,
      height: r.height,
      bandwidth: 1_000_000 * (i + 1),
      averageBandwidth: 800_000 * (i + 1),
      frameRate: 30,
      codecs: 'avc1.4d401f,mp4a.40.2',
      playlist: `r/${r.rung}/a1/index.m3u8`,
    }));
    const master = buildMasterPlaylist(measured);
    expect(master.startsWith('#EXTM3U\n')).toBe(true);
    expect(master.match(/#EXT-X-STREAM-INF/g)).toHaveLength(3);
    expect(master).toContain('RESOLUTION=1280x720');
    expect(master).toContain('r/720/a1/index.m3u8');
  });
});
