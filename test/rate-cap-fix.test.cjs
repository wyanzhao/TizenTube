const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

const code = fs
  .readFileSync(__dirname + '/../mods/features/rateCapFix.js', 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace(/export (function|const)/g, '$1');

// Simulated Cobalt MediaSource: honours framerate/bitrate parameters, rejects > 60fps and > 60 Mbps.
function cobalt(log) {
  return t => {
    if (log) log.push(t);
    const f = /framerate=([0-9.]+)/.exec(t);
    const b = /bitrate=([0-9.]+)/.exec(t);
    return !(f && Number(f[1]) > 60) && !(b && Number(b[1]) > 6e7);
  };
}

function setup(opts = {}) {
  const listeners = {};
  const state = { speed: opts.speed || 1, writes: [] };
  const log = [];
  const MS = { isTypeSupported: cobalt(log) };
  const v = { tagName: 'VIDEO', playbackRate: state.speed, currentTime: 42, readyState: 4, seeking: false };
  const storage = new Map();
  const window = {
    MediaSource: MS,
    sessionStorage: {
      getItem: k => storage.get(k) || null,
      removeItem: k => storage.delete(k)
    }
  };
  const context = {
    window,
    Number,
    Math,
    Object,
    JSON,
    configRead: k => (k === 'videoSpeed' ? state.speed : undefined),
    configWrite: (k, x) => {
      state.writes.push([k, x]);
      if (k === 'videoSpeed') state.speed = x;
    },
    document: {
      querySelector: () => v,
      addEventListener: (k, f) => {
        listeners[k] = f;
      }
    }
  };
  vm.runInNewContext(code, context);
  return { context, window, MS, log, listeners, state, v, storage };
}

// Mirror of the YouTube TV player's rate cap (u5/OCa/fAa/lva, player cbcfbf2f).
function playerCap(isTypeSupported, formats, rate) {
  if (!(rate > 1 && formats.some(f => f.fps > 32))) return 0;
  let d = 480;
  for (const f of formats) {
    if (f.height <= 1080 && f.height > d) {
      const t = `video/webm; codecs="vp9"; width=${f.width}; height=${f.height}; framerate=${f.fps * rate}; bitrate=${f.bps * 8 * rate}`;
      if (isTypeSupported(t)) d = f.height;
    }
  }
  return d;
}

const CLIP = [
  { width: 1280, height: 720, fps: 30, bps: 142e3 },
  { width: 1280, height: 720, fps: 60, bps: 221e3 },
  { width: 1920, height: 1080, fps: 60, bps: 1383e3 },
  { width: 3840, height: 2160, fps: 60, bps: 6052e3 }
];
const HFR_ONLY = CLIP.filter(f => !(f.height === 720 && f.fps === 30));

test('without shim the player caps 60fps video to 480p at any rate above 1 (observed bug)', () => {
  const raw = cobalt();
  for (const r of [1.25, 1.5, 2]) {
    assert.equal(playerCap(raw, HFR_ONLY, r), 480);
  }
  // A video that also has 720p30 is capped at 720p instead.
  assert.equal(playerCap(raw, CLIP, 2), 720);
  assert.equal(playerCap(raw, CLIP, 1), 0);
});

test('with shim the same player logic allows 1080p60 at 1.25x, 1.5x and 2x', () => {
  const x = setup();
  assert.equal(x.window.__ttRateCapFix.installed, true);
  for (const r of [1.25, 1.5, 2]) {
    for (const c of [CLIP, HFR_ONLY]) {
      assert.equal(
        playerCap(q => x.MS.isTypeSupported(q), c, r),
        1080
      );
    }
  }
  assert.ok(x.window.__ttRateCapFix.rewrites > 0);
});

test('rewrite asks Cobalt about native 60fps and scales bitrate back', () => {
  const x = setup();
  const rw = x.context.rewriteQuery;
  assert.equal(
    rw('video/webm; codecs="vp9"; width=1920; height=1080; framerate=120; bitrate=22128000'),
    'video/webm; codecs="vp9"; width=1920; height=1080; framerate=60; bitrate=11064000'
  );
  assert.equal(
    rw('video/mp4; codecs="avc1"; width=1280; height=720; framerate=75'),
    'video/mp4; codecs="avc1"; width=1280; height=720; framerate=60'
  );
});

test('queries at or below 60fps, audio, platform probes and out-of-envelope queries pass through unchanged', () => {
  const x = setup();
  const rw = x.context.rewriteQuery;
  const untouched = [
    'video/webm; codecs="vp9"; width=1920; height=1080; framerate=60',
    'video/webm; codecs="vp9"; framerate=9999',
    'audio/webm; codecs="opus"; framerate=120',
    'video/webm; codecs="vp9"; width=1920; height=1080; framerate=240',
    'video/webm; codecs="vp9"; framerate=120',
    'video/webm; codecs="vp9"',
    null,
    42
  ];
  for (const q of untouched) {
    assert.equal(rw(q), null);
  }
  for (const h of [1440, 2160, 4320]) {
    assert.equal(rw(`video/webm; codecs="vp9"; width=3840; height=${h}; framerate=120`), null);
  }
  assert.equal(rw('video/webm; codecs="vp9"; width=1920; height=1080; framerate=120', 720), null);
  x.MS.isTypeSupported('video/webm; codecs="vp9"; framerate=9999');
  assert.equal(x.log.at(-1), 'video/webm; codecs="vp9"; framerate=9999');
});

test('platform capability probe still sees the real answer, so the player keeps sending framerate', () => {
  const x = setup();
  assert.equal(x.MS.isTypeSupported('video/webm; codecs="vp9"; framerate=30'), true);
  assert.equal(x.MS.isTypeSupported('video/webm; codecs="vp9"; framerate=9999'), false);
});

test('shim installs once and keeps the original for measurement', () => {
  const x = setup();
  const first = x.MS.isTypeSupported;
  assert.equal(x.context.installShim(x.window), true);
  assert.equal(x.MS.isTypeSupported, first);
  assert.equal(typeof x.window.__ttOriginalIsTypeSupported, 'function');
  assert.equal(
    x.window.__ttOriginalIsTypeSupported('video/webm; codecs="vp9"; width=1920; height=1080; framerate=120'),
    false
  );
});

test('missing MediaSource is tolerated', () => {
  const x = setup();
  assert.equal(x.context.installShim({}), false);
});

test('speed chosen in YouTube native menu during playback is remembered; loading resets are ignored', () => {
  const x = setup();
  x.v.playbackRate = 2;
  x.listeners.ratechange({ target: x.v });
  assert.equal(x.state.speed, 2);
  x.v.readyState = 1;
  x.v.currentTime = 0;
  x.v.playbackRate = 1;
  x.listeners.ratechange({ target: x.v });
  assert.equal(x.state.speed, 2);
  x.listeners.canplay({ target: x.v });
  assert.equal(x.v.playbackRate, 2);
  x.v.readyState = 4;
  x.v.currentTime = 50;
  x.v.playbackRate = 4;
  x.listeners.ratechange({ target: x.v });
  assert.equal(x.state.speed, 2);
});

test('no page reload, polling or quality locking remains', () => {
  assert.ok(!/location\.reload/.test(code));
  assert.ok(!/setInterval/.test(code));
  assert.ok(!/setPlaybackQualityRange/.test(code));
});
