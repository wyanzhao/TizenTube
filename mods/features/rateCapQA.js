// Developer measurement tool. Not part of the default build (see tools/build.py --with-qa).
// Inert unless a short-lived private qa-enable.json exists in the app data directory on the TV.
// Measures (1) Cobalt's raw answers for high-frame-rate queries and (2) real playback of an
// owner-selected 60fps clip at several rates/qualities with the capability shim active.
import { configWrite } from '../config.js';

const QA_ENDPOINT = '/__tizentube_local__/qa';
let clip = null;

// api: speed set through YouTube's own player API (same path as YouTube's speed menu).
// shim: 0 temporarily restores Cobalt's original isTypeSupported to reproduce the cap.
export const PHASES = [
  { id: 1, rate: 2, quality: null, api: 1, shim: 1 },
  { id: 2, rate: 2, quality: null, api: 1, shim: 0 },
  { id: 3, rate: 2, quality: 'hd1080', api: 1, shim: 0 },
  { id: 4, rate: 2, quality: 'hd1080', api: 1, shim: 1 },
  { id: 5, rate: 1.5, quality: null, api: 1, shim: 1 }
];

const PHASE_MS = 48000;
const TICK_MS = 2000;
let stopped = false;
let priorMuted;
let phaseIndex = -1;
let phaseStart = 0;
let probed = false;
let loads = 0;
let wrappedShim = null;

function post(body) {
  return fetch(QA_ENDPOINT, {
    method: 'POST',
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).catch(() => {});
}

export function probeCapabilities(test) {
  const out = { kind: 1 };
  const codecs = [
    ['vp9', 'video/webm; codecs="vp9"'],
    ['avc', 'video/mp4; codecs="avc1.64002A"'],
    ['av1', 'video/mp4; codecs="av01.0.09M.08"']
  ];
  const resolutions = [
    [1280, 720],
    [1920, 1080],
    [2560, 1440],
    [3840, 2160]
  ];
  for (const c of codecs) {
    for (const [w, h] of resolutions) {
      for (const f of [30, 60, 75, 90, 120]) {
        let ok = 0;
        try {
          ok = test(`${c[1]}; width=${w}; height=${h}; framerate=${f}`) ? 1 : 0;
        } catch (_) {
          ok = 0;
        }
        out[`${c[0]}_${h}_${f}`] = ok;
      }
    }
  }
  try {
    out.vp9_fr_9999 = test('video/webm; codecs="vp9"; framerate=9999') ? 1 : 0;
  } catch (_) {
    out.vp9_fr_9999 = 0;
  }
  return out;
}

function player() {
  return document.querySelector('.html5-video-player');
}

function setShim(on) {
  const MS = window.MediaSource;
  const orig = window.__ttOriginalIsTypeSupported;
  if (!MS || !orig) return;
  if (!wrappedShim && MS.isTypeSupported && MS.isTypeSupported.__ttRateCapShim) {
    wrappedShim = MS.isTypeSupported;
  }
  const want = on ? wrappedShim : orig;
  if (!want) return;
  try {
    MS.isTypeSupported = want;
  } catch (_) {}
  if (MS.isTypeSupported !== want) {
    try {
      Object.defineProperty(MS, 'isTypeSupported', { value: want, configurable: true, writable: true });
    } catch (_) {}
  }
}

function shimActive() {
  const MS = window.MediaSource;
  return MS && MS.isTypeSupported && MS.isTypeSupported.__ttRateCapShim ? 1 : 0;
}

function setRate(ph) {
  const p = player();
  const v = document.querySelector('video');
  if (ph.api && p && typeof p.setPlaybackRate === 'function') {
    try {
      p.setPlaybackRate(ph.rate);
    } catch (_) {}
  } else if (v) {
    v.playbackRate = ph.rate;
  }
}

function cleanup() {
  if (stopped) return;
  stopped = true;
  // Production (no QA file): stop quietly without touching the owner's speed or quality.
  if (phaseIndex < 0) return;
  configWrite('videoSpeed', 1);
  const v = document.querySelector('video');
  const p = player();
  setShim(true);
  try {
    p && p.setPlaybackRate && p.setPlaybackRate(1);
  } catch (_) {}
  if (v) {
    v.playbackRate = 1;
    if (priorMuted !== undefined) v.muted = priorMuted;
  }
  try {
    p && p.setPlaybackQualityRange && p.setPlaybackQualityRange('auto', 'auto');
  } catch (_) {}
}

function startPhase(i) {
  phaseIndex = i;
  phaseStart = Date.now();
  const ph = PHASES[i];
  const p = player();
  setShim(!!ph.shim);
  if (!ph.api) configWrite('videoSpeed', ph.rate);
  if (i === 0 && p && typeof p.loadVideoById === 'function') {
    p.loadVideoById({ videoId: clip, startSeconds: 30 });
    loads++;
  }
  setRate(ph);
  try {
    if (p && p.setPlaybackQualityRange) {
      p.setPlaybackQualityRange(ph.quality || 'auto', ph.quality || 'auto');
    }
  } catch (_) {}
}

function sample() {
  const p = player();
  const v = document.querySelector('video');
  const ph = PHASES[phaseIndex] || { id: 0, rate: 0 };
  let id = null;
  let q = null;
  let dropped = 0;
  let total = 0;
  let prate = 0;

  try {
    prate = p && p.getPlaybackRate ? Number(p.getPlaybackRate()) || 0 : 0;
  } catch (_) {}
  try {
    id = p && p.getVideoData && p.getVideoData().video_id;
  } catch (_) {}
  try {
    q = p && p.getPlaybackQuality && p.getPlaybackQuality();
  } catch (_) {}
  try {
    const m = v && v.getVideoPlaybackQuality && v.getVideoPlaybackQuality();
    if (m) {
      dropped = m.droppedVideoFrames || 0;
      total = m.totalVideoFrames || 0;
    }
  } catch (_) {}

  if (v) {
    if (priorMuted === undefined) priorMuted = v.muted;
    v.muted = true;
    if (v.paused) {
      const a = v.play();
      if (a && a.catch) a.catch(() => {});
    }
  }

  const s = window.__ttRateCapFix || {};
  const qmap = {
    tiny: 144,
    small: 240,
    medium: 360,
    large: 480,
    hd720: 720,
    hd1080: 1080,
    hd1440: 1440,
    hd2160: 2160,
    highres: 4320
  };

  return {
    kind: 2,
    at: Date.now(),
    phase: ph.id,
    target: ph.rate,
    quality: qmap[q] || 0,
    width: v ? v.videoWidth : 0,
    height: v ? v.videoHeight : 0,
    rate: v ? v.playbackRate : 0,
    time: v ? v.currentTime : 0,
    ready: v ? v.readyState : 0,
    paused: v && v.paused ? 1 : 0,
    dropped,
    total,
    rewrites: s.rewrites || 0,
    shim: shimActive(),
    prate,
    testClip: id === clip ? 1 : 0,
    loads
  };
}

function tick() {
  fetch(QA_ENDPOINT, { credentials: 'omit', cache: 'no-store' })
    .then(r => (r.status === 200 ? r.json() : null))
    .then(qa => {
      if (!qa || !/^[-_a-zA-Z0-9]{11}$/.test(qa.clip || '') || qa.expires < Date.now() || (clip && qa.clip !== clip)) {
        cleanup();
        return;
      }
      clip = qa.clip;
      if (!probed) {
        probed = true;
        const raw =
          window.__ttOriginalIsTypeSupported ||
          (window.MediaSource && window.MediaSource.isTypeSupported.bind(window.MediaSource));
        return post(probeCapabilities(raw));
      }
      if (phaseIndex < 0) {
        if (player() && typeof player().loadVideoById === 'function') startPhase(0);
        return;
      }
      if (Date.now() - phaseStart >= PHASE_MS) {
        if (phaseIndex + 1 >= PHASES.length) {
          post({ kind: 3, at: Date.now(), done: 1 });
          cleanup();
          return;
        }
        startPhase(phaseIndex + 1);
      }
      return post(sample());
    })
    .catch(() => {})
    .then(() => {
      if (!stopped) setTimeout(tick, TICK_MS);
    });
}

setTimeout(tick, 3000);
