import {
  avcCodec,
  buildMasterPlaylist,
  codecsFor,
  LADDER,
  ladderFor,
  measureSegments,
  outputFrameRate,
  peakKbps,
  renditionArgs,
  type MeasuredRendition,
} from './hls';

describe('HLS ladder and master playlist', () => {
  describe('ladder', () => {
    // [width, height, expected rung ids, expected output heights]
    const table: [number, number, number[], number[]][] = [
      [3840, 2160, [240, 480, 720, 1080], [240, 480, 720, 1080]],
      [1920, 1080, [240, 480, 720, 1080], [240, 480, 720, 1080]],
      [1778, 1000, [240, 480, 720], [240, 480, 720]],
      [1280, 720, [240, 480, 720], [240, 480, 720]],
      [853, 479, [240], [240]],
      [853, 480, [240, 480], [240, 480]],
      [427, 240, [240], [240]],
      [425, 239, [240], [238]],
      [256, 144, [240], [144]],
    ];

    it.each(table)(
      'S30 AS-17: source %ix%i -> rungs %j at heights %j',
      (w, h, rungs, heights) => {
        const ladder = ladderFor(w, h);
        expect(ladder.map((r) => r.rung)).toEqual(rungs);
        expect(ladder.map((r) => r.height)).toEqual(heights);
      },
    );

    it.each(table)(
      'S30 AS-17: %ix%i never enlarges and keeps even sizes and the aspect ratio',
      (w, h) => {
        for (const r of ladderFor(w, h)) {
          expect(r.height).toBeLessThanOrEqual(h);
          expect(r.width).toBeLessThanOrEqual(w + 1);
          expect(r.width % 2).toBe(0);
          expect(r.height % 2).toBe(0);
          expect(Math.abs(r.width - (w * r.height) / h)).toBeLessThanOrEqual(1);
        }
      },
    );

    it.each([
      [1281, 721],
      [853, 481],
      [1919, 1079],
      [3839, 2159],
      [17, 17],
      [31, 16],
    ])('S30 AS-17: odd source %ix%i still yields even output sizes', (w, h) => {
      for (const r of ladderFor(w, h)) {
        expect(r.width % 2).toBe(0);
        expect(r.height % 2).toBe(0);
        expect(Math.abs(r.width - (w * r.height) / h)).toBeLessThanOrEqual(1);
      }
    });

    it('S30 AS-17: a source below the lowest rung gets one rung at its own even height', () => {
      const [r] = ladderFor(200, 150);
      expect(r).toMatchObject({ rung: 240, height: 150, width: 200 });
      expect(r.videoKbps).toBe(LADDER[0].videoKbps);
    });

    it.each([2160, 1080, 1000, 720, 479, 240, 239, 144, 16])(
      'S30 AS-17: the lowest rung of a %ip source peaks at <= 600 kbps in total',
      (h) => {
        const lowest = ladderFor(Math.round((h * 16) / 9), h)[0];
        expect(peakKbps(lowest)).toBeLessThanOrEqual(600);
      },
    );

    it('S30 FR-030: the bitrates of the four rungs', () => {
      expect(LADDER.map((r) => [r.rung, r.videoKbps, r.audioKbps])).toEqual([
        [240, 400, 64],
        [480, 1400, 96],
        [720, 2800, 128],
        [1080, 5000, 128],
      ]);
    });
  });

  describe('output frame rate', () => {
    it.each([
      [24, 24],
      [25, 25],
      [29.97, 30],
      [30, 30],
      [50, 50],
      [59.94, 60],
      [60, 60],
      [120, 60],
      [12, 24],
      [0, 24],
      [Number.NaN, 24],
    ])('S30 AS-18: source %f fps -> output %i fps', (src, out) => {
      expect(outputFrameRate(src)).toBe(out);
    });
  });

  describe('rendition arguments', () => {
    const [r720] = ladderFor(1280, 720).slice(-1);
    const args = (fps: number, hasAudio = true) =>
      renditionArgs({
        input: '/tmp/in.mp4',
        outDir: '/tmp/out',
        rendition: r720,
        fps,
        hasAudio,
      });
    const after = (a: string[], flag: string) => a[a.indexOf(flag) + 1];

    it.each([24, 25, 30, 50, 60])(
      'S30 AS-18: at %i fps keyframes are at fixed times and the frame rate is constant',
      (fps) => {
        const a = args(fps);
        expect(after(a, '-force_key_frames')).toBe('expr:gte(t,n_forced*2)');
        expect(after(a, '-sc_threshold')).toBe('0');
        expect(after(a, '-r')).toBe(String(fps));
        expect(after(a, '-g')).toBe(String(fps * 2));
        expect(after(a, '-keyint_min')).toBe(String(fps * 2));
        expect(after(a, '-hls_time')).toBe('4');
        expect(after(a, '-hls_playlist_type')).toBe('vod');
        expect(after(a, '-hls_flags')).toBe('independent_segments');
      },
    );

    it('S30 AS-17: the filter scales to the exact even output size', () => {
      expect(after(args(30), '-vf')).toBe(`scale=${r720.width}:${r720.height}`);
    });

    it('S30 AS-19: a source without audio is encoded with -an and no audio flags', () => {
      const a = args(30, false);
      expect(a).toContain('-an');
      expect(a).not.toContain('-c:a');
      expect(a).not.toContain('-b:a');
    });

    it('S30 AS-19: a source with audio carries the rung audio bitrate', () => {
      const a = args(30, true);
      expect(a).not.toContain('-an');
      expect(after(a, '-b:a')).toBe('128k');
    });

    it('S30 AS-25: arguments are a plain list: input and outputs are single elements', () => {
      const a = renditionArgs({
        input: '/tmp/in put; rm -rf x.mp4',
        outDir: '/tmp/o ut',
        rendition: r720,
        fps: 30,
        hasAudio: true,
      });
      expect(a).toContain('/tmp/in put; rm -rf x.mp4');
      expect(a.at(-1)).toBe('/tmp/o ut/index.m3u8');
      expect(after(a, '-hls_segment_filename')).toBe('/tmp/o ut/seg_%05d.ts');
    });
  });

  describe('measured bitrates', () => {
    it('S30 AS-19: peak is the highest segment bitrate, average the total', () => {
      const m = measureSegments([
        { bytes: 500_000, durationSec: 4 }, // 1,000,000 bps
        { bytes: 750_000, durationSec: 4 }, // 1,500,000 bps
        { bytes: 250_000, durationSec: 2 }, // 1,000,000 bps
      ]);
      expect(m.peak).toBe(1_500_000);
      expect(m.average).toBe(Math.round((1_500_000 * 8) / 10));
    });

    it('S30 AS-19: peak is never below any segment (rounded up)', () => {
      const segs = [{ bytes: 333_333, durationSec: 3.7 }];
      const m = measureSegments(segs);
      expect(m.peak).toBeGreaterThanOrEqual((333_333 * 8) / 3.7);
    });

    it.each([
      [[]],
      [[{ bytes: 10, durationSec: 0 }]],
      [[{ bytes: -1, durationSec: 4 }]],
    ])('S30 AS-19: invalid segments %j are refused', (segs) => {
      expect(() => measureSegments(segs)).toThrow();
    });
  });

  describe('codecs', () => {
    it.each([
      ['baseline', 30, 'avc1.42e01e'],
      ['main', 31, 'avc1.4d401f'],
      ['main', 40, 'avc1.4d4028'],
      ['high', 41, 'avc1.640029'],
    ] as const)('S30 AS-19: avcCodec(%s, %i) = %s', (p, l, expected) => {
      expect(avcCodec(p, l)).toBe(expected);
    });

    it('S30 AS-19: audio-less renditions name no audio codec', () => {
      expect(codecsFor({ profile: 'main', level: 31, hasAudio: false })).toBe(
        'avc1.4d401f',
      );
      expect(codecsFor({ profile: 'main', level: 31, hasAudio: true })).toBe(
        'avc1.4d401f,mp4a.40.2',
      );
    });
  });

  describe('master playlist', () => {
    const rendition = (
      over: Partial<MeasuredRendition>,
    ): MeasuredRendition => ({
      name: '480',
      width: 854,
      height: 480,
      bandwidth: 1_650_000,
      averageBandwidth: 1_500_000,
      frameRate: 30,
      codecs: 'avc1.4d401f,mp4a.40.2',
      playlist: 'r/480/a1/index.m3u8',
      ...over,
    });
    const lines = (s: string) => s.trim().split('\n');

    it('S30 AS-19: one entry per rendition, ascending bandwidth, from measured values', () => {
      const master = buildMasterPlaylist([
        rendition({
          name: '720',
          width: 1280,
          height: 720,
          bandwidth: 3_300_000,
          averageBandwidth: 3_000_000,
          frameRate: 29.97,
          playlist: 'r/720/a2/index.m3u8',
        }),
        rendition({
          name: '240',
          width: 426,
          height: 240,
          bandwidth: 520_000,
          averageBandwidth: 470_000,
          frameRate: 25,
          playlist: 'r/240/a1/index.m3u8',
        }),
        rendition({}),
      ]);
      const l = lines(master);
      expect(l[0]).toBe('#EXTM3U');
      expect(l).toContain('#EXT-X-INDEPENDENT-SEGMENTS');
      const infs = l.filter((x) => x.startsWith('#EXT-X-STREAM-INF:'));
      expect(infs).toHaveLength(3);
      expect(infs[0]).toBe(
        '#EXT-X-STREAM-INF:BANDWIDTH=520000,AVERAGE-BANDWIDTH=470000,RESOLUTION=426x240,FRAME-RATE=25.000,CODECS="avc1.4d401f,mp4a.40.2"',
      );
      expect(infs[2]).toContain('BANDWIDTH=3300000');
      expect(infs[2]).toContain('FRAME-RATE=29.970');
      expect(infs[2]).toContain('RESOLUTION=1280x720');
      const uris = l.filter((x) => !x.startsWith('#'));
      expect(uris).toEqual([
        'r/240/a1/index.m3u8',
        'r/480/a1/index.m3u8',
        'r/720/a2/index.m3u8',
      ]);
      // each uri follows its own STREAM-INF line
      const i = l.indexOf('r/720/a2/index.m3u8');
      expect(l[i - 1]).toContain('RESOLUTION=1280x720');
      expect(master.endsWith('\n')).toBe(true);
    });

    it('S30 AS-19: an audio-less rendition lists no audio codec', () => {
      const master = buildMasterPlaylist([
        rendition({
          codecs: codecsFor({ profile: 'main', level: 31, hasAudio: false }),
        }),
      ]);
      expect(master).toContain('CODECS="avc1.4d401f"');
      expect(master).not.toContain('mp4a');
    });

    it('S30 AS-19: the output is independent of input order (two package attempts write the same bytes)', () => {
      const a = rendition({
        name: '240',
        bandwidth: 500_000,
        averageBandwidth: 450_000,
        playlist: 'r/240/a1/index.m3u8',
      });
      const b = rendition({});
      expect(buildMasterPlaylist([a, b])).toBe(buildMasterPlaylist([b, a]));
    });

    it('S30 AS-19: no rendition is an error, not an empty master', () => {
      expect(() => buildMasterPlaylist([])).toThrow();
    });

    it.each([
      ['bandwidth', { bandwidth: 0 }],
      ['average bandwidth above peak', { averageBandwidth: 2_000_000 }],
      ['frame rate', { frameRate: 0 }],
      ['empty codecs', { codecs: '' }],
      ['odd width', { width: 853 }],
      ['quote in codecs', { codecs: 'avc1"x' }],
    ])('S30 AS-19: invalid measured value (%s) is refused', (_n, over) => {
      expect(() => buildMasterPlaylist([rendition(over)])).toThrow();
    });
  });
});
