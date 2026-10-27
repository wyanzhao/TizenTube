const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

const code = fs
  .readFileSync(__dirname + '/../mods/features/rateCapQA.js', 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace(/export (function|const)/g, '$1');

function setup(qaStatus) {
  const timers = [];
  const posts = [];
  const state = { speed: 1.5, ranges: [], apiRates: [] };
  const v = {
    tagName: 'VIDEO',
    playbackRate: 1.5,
    muted: false,
    paused: false,
    videoWidth: 1920,
    videoHeight: 1080,
    currentTime: 40,
    readyState: 4,
    getVideoPlaybackQuality: () => ({ droppedVideoFrames: 2, totalVideoFrames: 500 }),
    play() {}
  };
  const p = {
    rate: 1.5,
    setPlaybackRate(r) {
      this.rate = r;
      state.apiRates.push(r);
    },
    getPlaybackRate() {
      return this.rate;
    },
    loadVideoById() {},
    getVideoData: () => ({ video_id: 'TESTCLIP001' }),
    getPlaybackQuality: () => 'hd1080',
    setPlaybackQualityRange: (a, b) => state.ranges.push([a, b])
  };
  const fetch = (u, o = {}) => {
    if (o.method === 'POST') {
      posts.push(JSON.parse(o.body));
      return Promise.resolve({ status: 204 });
    }
    return Promise.resolve({
      status: qaStatus,
      json: () => Promise.resolve({ clip: 'TESTCLIP001', expires: Date.now() + 3600000 })
    });
  };
  const orig = t => !/framerate=(7|9|12)/.test(t);
  const shim = () => true;
  shim.__ttRateCapShim = true;
  const window = {
    MediaSource: { isTypeSupported: shim },
    __ttOriginalIsTypeSupported: orig,
    __ttRateCapFix: { installed: true, rewrites: 4 }
  };
  const context = {
    window,
    fetch,
    Date,
    Promise,
    JSON,
    Number,
    console,
    setTimeout: f => {
      timers.push(f);
      return timers.length;
    },
    configWrite: (k, x) => {
      if (k === 'videoSpeed') state.speed = x;
    },
    document: { querySelector: s => (s === 'video' ? v : p) }
  };
  vm.runInNewContext(code, context);
  const step = async () => {
    const f = timers.shift();
    if (f) f();
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setImmediate(r));
    }
  };
  return { context, posts, state, v, step, timers, window, shim, orig };
}

test('production (QA file absent) never changes speed, mute or quality', async () => {
  const x = setup(404);
  await x.step();
  assert.equal(x.state.speed, 1.5);
  assert.equal(x.v.playbackRate, 1.5);
  assert.equal(x.v.muted, false);
  assert.equal(x.state.ranges.length, 0);
  assert.equal(x.posts.length, 0);
  assert.equal(x.timers.length, 0);
});

test('capability probe records numeric answers within proxy key limits', () => {
  const x = setup(404);
  const r = x.context.probeCapabilities(t => !/framerate=(75|90|120)/.test(t));
  const keys = Object.keys(r);
  assert.ok(keys.length <= 72);
  assert.ok(keys.every(k => /^[a-z][a-z0-9_]{0,23}$/i.test(k)));
  assert.equal(r.vp9_1080_60, 1);
  assert.equal(r.vp9_1080_120, 0);
  assert.equal(r.kind, 1);
  assert.ok(Object.values(r).every(v => typeof v === 'number'));
});

test('QA run probes, then samples numeric metrics through all phases and restores state', async () => {
  const x = setup(200);
  const realNow = Date.now;
  let now = realNow();
  x.context.Date = { now: () => now };
  await x.step();
  assert.equal(x.posts[0].kind, 1);
  await x.step();
  assert.deepEqual(x.state.apiRates, [2]);
  assert.deepEqual(x.state.ranges.at(-1), ['auto', 'auto']);
  assert.equal(x.window.MediaSource.isTypeSupported, x.shim);
  await x.step();
  const s = x.posts.at(-1);
  assert.equal(s.kind, 2);
  assert.equal(s.phase, 1);
  assert.equal(s.prate, 2);
  assert.equal(s.shim, 1);
  assert.equal(s.dropped, 2);
  assert.equal(s.quality, 1080);
  assert.ok(Object.values(s).every(v => typeof v === 'number'));
  now += 49000;
  await x.step();
  assert.equal(x.window.MediaSource.isTypeSupported, x.orig);
  assert.equal(x.posts.at(-1).shim, 0);
  for (let i = 0; i < 5; i++) {
    now += 49000;
    await x.step();
  }
  assert.equal(x.posts.some(p => p.kind === 3), true);
  assert.equal(x.state.speed, 1);
  assert.equal(x.state.apiRates.at(-1), 1);
  assert.equal(x.window.MediaSource.isTypeSupported, x.shim);
  assert.equal(x.v.muted, false);
  assert.deepEqual(x.state.ranges.at(-1), ['auto', 'auto']);
  assert.equal(x.timers.length, 0);
  assert.deepEqual([...new Set(x.posts.filter(p => p.kind === 2).map(p => p.phase))], [1, 2, 3, 4, 5]);
});
