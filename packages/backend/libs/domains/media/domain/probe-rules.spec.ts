import {
  DECODABLE_VIDEO_CODECS,
  displaySize,
  PROBE_LIMITS,
  validateProbe,
  type ProbeResult,
} from './probe-rules';

const ok = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  readable: true,
  durationSec: 6,
  hasAudio: true,
  video: { codec: 'h264', width: 1280, height: 720, fps: 30, rotation: 0 },
  ...over,
});
const withVideo = (
  v: Partial<NonNullable<ProbeResult['video']>>,
): ProbeResult => ok({ video: { ...ok().video!, ...v } });

describe('source validation', () => {
  it('S30 AS-20: the limits are the ones of FR-029', () => {
    expect(PROBE_LIMITS).toEqual({
      minDurationSec: 1,
      maxDurationSec: 7200,
      maxWidth: 3840,
      maxHeight: 2160,
      minDimension: 16,
    });
  });

  it('S30 AS-20: a normal source passes', () => {
    expect(validateProbe(ok())).toEqual({ ok: true });
  });

  // [name, probe, expected code | null]
  const cases: [string, ProbeResult, string | null][] = [
    ['unreadable data', ok({ readable: false, video: null }), 'not_a_video'],
    [
      'unreadable data even with a stream listed',
      ok({ readable: false }),
      'not_a_video',
    ],
    ['audio only', ok({ video: null }), 'no_video_stream'],
    ['duration exactly 7200 s', ok({ durationSec: 7200 }), null],
    ['duration 7200.001 s', ok({ durationSec: 7200.001 }), 'duration_exceeded'],
    ['duration 7201 s', ok({ durationSec: 7201 }), 'duration_exceeded'],
    ['duration exactly 1 s', ok({ durationSec: 1 }), null],
    ['duration 0.999 s', ok({ durationSec: 0.999 }), 'duration_too_short'],
    ['duration 0 s', ok({ durationSec: 0 }), 'duration_too_short'],
    ['unknown duration', ok({ durationSec: null }), 'not_a_video'],
    ['NaN duration', ok({ durationSec: Number.NaN }), 'not_a_video'],
    ['negative duration', ok({ durationSec: -3 }), 'duration_too_short'],
    ['3840x2160', withVideo({ width: 3840, height: 2160 }), null],
    [
      '3841x2160',
      withVideo({ width: 3841, height: 2160 }),
      'resolution_exceeded',
    ],
    [
      '3840x2161',
      withVideo({ width: 3840, height: 2161 }),
      'resolution_exceeded',
    ],
    ['16x16', withVideo({ width: 16, height: 16 }), null],
    ['15x16', withVideo({ width: 15, height: 16 }), 'resolution_exceeded'],
    ['16x15', withVideo({ width: 16, height: 15 }), 'resolution_exceeded'],
    ['0x0', withVideo({ width: 0, height: 0 }), 'resolution_exceeded'],
    [
      'a codec the platform cannot decode',
      withVideo({ codec: 'cinepak' }),
      'not_a_video',
    ],
    ['an empty codec name', withVideo({ codec: '' }), 'not_a_video'],
    // rotation: the DISPLAY size is what is limited
    [
      '2160x3840 portrait stored as 3840x2160 rotated 90',
      withVideo({ width: 3840, height: 2160, rotation: 90 }),
      'resolution_exceeded',
    ],
    [
      '2160x3840 stored upright',
      withVideo({ width: 2160, height: 3840, rotation: 0 }),
      'resolution_exceeded',
    ],
    [
      '2160x3840 stored as 3840x2160 rotated 270 (-90)',
      withVideo({ width: 3840, height: 2160, rotation: -90 }),
      'resolution_exceeded',
    ],
    [
      '1080x1920 portrait is within the limits',
      withVideo({ width: 1080, height: 1920, rotation: 0 }),
      null,
    ],
  ];

  it.each(cases)('S30 AS-20: %s', (_name, probe, code) => {
    const result = validateProbe(probe);
    if (code === null) expect(result).toEqual({ ok: true });
    else expect(result).toEqual({ ok: false, code });
  });

  it('S30 AS-20: every platform codec is accepted, every other rejected', () => {
    for (const codec of DECODABLE_VIDEO_CODECS)
      expect(validateProbe(withVideo({ codec }))).toEqual({ ok: true });
    for (const codec of ['cinepak', 'indeo3', 'unknown', 'H264 '])
      expect(validateProbe(withVideo({ codec }))).toEqual({
        ok: false,
        code: 'not_a_video',
      });
  });

  it('S30 AS-20: the checks run in a fixed order (unreadable, no stream, codec, duration, size)', () => {
    expect(
      validateProbe(withVideo({ codec: 'cinepak', width: 8000, height: 8000 })),
    ).toEqual({ ok: false, code: 'not_a_video' });
    expect(
      validateProbe({
        ...withVideo({ width: 8000, height: 8000 }),
        durationSec: 9000,
      }),
    ).toEqual({ ok: false, code: 'duration_exceeded' });
  });

  it('S30 AS-20: a source without audio is valid', () => {
    expect(validateProbe(ok({ hasAudio: false }))).toEqual({ ok: true });
  });

  it.each([
    [1280, 720, 0, [1280, 720]],
    [1280, 720, 90, [720, 1280]],
    [1280, 720, 270, [720, 1280]],
    [1280, 720, -90, [720, 1280]],
    [1280, 720, 180, [1280, 720]],
    [1280, 720, 360, [1280, 720]],
  ])(
    'S30 AS-20: displaySize(%i x %i rotated %i) = %j',
    (w, h, rotation, size) => {
      const v = { codec: 'h264', width: w, height: h, fps: 30, rotation };
      expect(displaySize(v)).toEqual({ width: size[0], height: size[1] });
    },
  );
});
