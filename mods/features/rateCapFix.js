import { configRead, configWrite } from '../config.js';

// Root cause (YouTube TV player; see docs/RATE_CAP_FIX.md):
// At playbackRate r > 1 on a video offering >32fps formats, the player caps quality to the
// highest format for which MediaSource.isTypeSupported('...; framerate=<fps*r>; bitrate=<bps*r>')
// returns true, defaulting to 480p, and resets the rate to 1x when a manual choice exceeds that cap.
// Cobalt on Samsung Tizen TVs rejects framerate > 60. The shim below asks Cobalt about the format at its
// native frame rate (framerate 60, bitrate scaled back by the same factor) inside the verified 1080p60
// envelope. Every other query passes through unchanged.
export const SHIM_MAX_HEIGHT = 1080;
export const SHIM_MAX_FRAMERATE = 120;

export function rewriteQuery(type, maxHeight = SHIM_MAX_HEIGHT) {
  if (typeof type !== 'string' || !/^video\//i.test(type)) return null;
  const fr = /;\s*framerate=([0-9]+(?:\.[0-9]+)?)/i.exec(type);
  if (!fr) return null;
  const f = Number(fr[1]);
  if (!(f > 60) || f > SHIM_MAX_FRAMERATE) return null;
  const h = /;\s*height=([0-9]+)/i.exec(type);
  if (!h || Number(h[1]) > maxHeight) return null;
  const factor = f / 60;
  return type
    .replace(fr[0], '; framerate=60')
    .replace(/;\s*bitrate=([0-9]+(?:\.[0-9]+)?)/i, (_, b) => '; bitrate=' + Math.ceil(Number(b) / factor));
}

const stats = {
  version: 'ratecapfix-1',
  installed: false,
  rewrites: 0,
  maxHeight: SHIM_MAX_HEIGHT,
  rateSource: null
};
window.__ttRateCapFix = stats;

export function installShim(target) {
  const MS = target && target.MediaSource;
  if (!MS || typeof MS.isTypeSupported !== 'function') return false;
  if (MS.isTypeSupported.__ttRateCapShim) return true;
  const original = MS.isTypeSupported.bind(MS);
  const wrapped = function isTypeSupported(type) {
    const rewritten = rewriteQuery(type);
    if (rewritten === null) return original(type);
    stats.rewrites++;
    return original(rewritten);
  };
  wrapped.__ttRateCapShim = true;
  target.__ttOriginalIsTypeSupported = original;
  try {
    MS.isTypeSupported = wrapped;
  } catch (_) {}
  if (MS.isTypeSupported !== wrapped) {
    try {
      Object.defineProperty(MS, 'isTypeSupported', { value: wrapped, configurable: true, writable: true });
    } catch (_) {}
  }
  stats.installed = MS.isTypeSupported === wrapped;
  return stats.installed;
}

installShim(window);

// Remember a speed chosen in YouTube's own menu, so TizenTube's canplay handlers re-apply it
// instead of reverting it. Rate changes while a new video loads are the player's own resets.
function validRate(r) {
  return Number.isFinite(r) && r >= 0.25 && r <= 2;
}

function established(v) {
  return v.readyState >= 3 && !v.seeking && Number(v.currentTime) > 1;
}

document.addEventListener(
  'ratechange',
  event => {
    const v = event.target;
    if (!v || v.tagName !== 'VIDEO') return;
    const r = Number(v.playbackRate);
    if (validRate(r) && r !== Number(configRead('videoSpeed')) && established(v)) {
      stats.rateSource = 'player';
      configWrite('videoSpeed', r);
    }
  },
  true
);

document.addEventListener(
  'canplay',
  event => {
    const v = event.target;
    const rate = Number(configRead('videoSpeed'));
    if (v && v.tagName === 'VIDEO' && validRate(rate) && v.playbackRate !== rate) {
      v.playbackRate = rate;
    }
  },
  true
);
