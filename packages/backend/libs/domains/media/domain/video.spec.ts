import { readyTasks, topoSort, videoPipeline } from './dag';
import { buildMasterPlaylist, ladderFor } from './hls';

/** DAG scheduling + HLS rules are pure and drive the whole pipeline. */
describe('video pipeline model', () => {
  it('topological order puts probe first and publish last; cycles are rejected', () => {
    const order = topoSort(videoPipeline(['240p', '480p']));
    expect(order[0]).toBe('probe');
    expect(order.at(-1)).toBe('publish');
    expect(order.indexOf('package')).toBeGreaterThan(order.indexOf('transcode:480p'));
    expect(() => topoSort([{ name: 'a', deps: ['b'] }, { name: 'b', deps: ['a'] }])).toThrow(/cycle/);
  });

  it('fan-out / fan-in: renditions and poster become ready together; package waits for every rendition', () => {
    const nodes = videoPipeline(['240p', '480p']).map((n) => ({ ...n, status: n.name === 'probe' ? ('DONE' as const) : ('PENDING' as const) }));
    expect(readyTasks(nodes).sort()).toEqual(['poster', 'transcode:240p', 'transcode:480p']);
    const partly = nodes.map((n) => (n.name === 'transcode:240p' ? { ...n, status: 'DONE' as const } : n));
    expect(readyTasks(partly)).not.toContain('package');
  });

  it('never upscales and writes a valid master playlist', () => {
    expect(ladderFor(720).map((r) => r.name)).toEqual(['240p', '480p', '720p']);
    expect(ladderFor(144).map((r) => r.name)).toEqual(['240p']);
    const master = buildMasterPlaylist([{ name: '480p', width: 854, height: 480, videoKbps: 1400, audioKbps: 96 }]);
    expect(master).toContain('#EXT-X-STREAM-INF:BANDWIDTH=1594000');
    expect(master.trim().split('\n').at(-1)).toBe('480p/index.m3u8');
  });
});
