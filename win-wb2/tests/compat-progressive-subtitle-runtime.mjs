import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const scriptPath = path.resolve('resources/jellyfin-web/jellium-series-compat.js');
const source = fs.readFileSync(scriptPath, 'utf8');
const instrumented = source.replace(
  /\n\}\)\(\);\s*$/,
  `
    window.__jelliumSubtitleTest = {
        start: progressiveSubtitleJsonResponse,
        session: function () { return progressiveSubtitleSession; }
    };
})();
`,
);

class FakeCue {
  constructor(start, end, text) {
    this.startTime = start;
    this.endTime = end;
    this.text = text;
  }
}

class FakeMutationObserver {
  constructor() {}
  observe() {}
  disconnect() {}
}

const listeners = new Map();
const video = {
  currentTime: 0,
  playbackRate: 2,
  seeking: false,
  textTracks: [],
  addEventListener(name, handler) {
    listeners.set(name, handler);
  },
  removeEventListener(name) {
    listeners.delete(name);
  },
};
const track = {
  label: 'manualTrack',
  mode: 'disabled',
  cues: [],
  addCue(cue) {
    this.cues.push(cue);
  },
  removeCue(cue) {
    const index = this.cues.indexOf(cue);
    if (index >= 0) this.cues.splice(index, 1);
  },
};
video.textTracks.push(track);

const storage = new Map();
storage.set('jellium-playback-rate', '2');
const document = {
  documentElement: {
    appendChild() {},
  },
  body: null,
  querySelector(selector) {
    if (selector === '.videoOsdBottom .buttons') {
      return null;
    }
    return selector.includes('video') ? video : null;
  },
  querySelectorAll(selector) {
    return selector.includes('video') ? [video] : [];
  },
  getElementById(id) {
    return id === 'jellium-settings-modal' ? {} : null;
  },
  createElement() {
    return {
      style: {},
      setAttribute() {},
      addEventListener() {},
      appendChild() {},
    };
  },
  addEventListener() {},
};

const timers = new Set();
const window = {
  localStorage: {
    getItem(key) {
      return storage.get(key) ?? null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
  },
  location: new URL('https://jellium.test/'),
  VTTCue: FakeCue,
  TextTrackCue: FakeCue,
  MutationObserver: FakeMutationObserver,
  addEventListener() {},
  setTimeout,
  clearTimeout,
  setInterval(callback, delay) {
    const timer = setInterval(callback, delay);
    timers.add(timer);
    return timer;
  },
  clearInterval(timer) {
    clearInterval(timer);
    timers.delete(timer);
  },
  fetch() {
    return Promise.resolve(new Response('', { status: 404 }));
  },
};

let subtitleRequests = 0;
const nativeFetch = async (input) => {
  const url = String(input);
  if (!url.includes('/Subtitles/2/')) {
    return new Response('', { status: 404 });
  }
  subtitleRequests += 1;
  assert.match(url, /Stream\.js/, 'subtitle windows should use Jellyfin TrackEvents JSON');
  const ticks = Number((url.match(/Subtitles\/2\/(\d+)\/Stream\.js/) || [])[1] || 0);
  const start = ticks / 10000000;
  // Make the append window deliberately slow, then seek away while it is in
  // flight. The stale response must be ignored after the session run changes.
  if (start >= 29 && start < 30) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return new Response(JSON.stringify({
    TrackEvents: [
      {
        StartPositionTicks: Math.round((start + 1) * 10000000),
        EndPositionTicks: Math.round((start + 3) * 10000000),
        Text: `cue-${subtitleRequests}-a`,
      },
      {
        StartPositionTicks: Math.round((start + 10) * 10000000),
        EndPositionTicks: Math.round((start + 12) * 10000000),
        Text: `cue-${subtitleRequests}-b`,
      },
    ],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const context = {
  window,
  document,
  performance,
  URL,
  URLSearchParams,
  Request,
  Response,
  Headers,
  AbortController,
  TextDecoder,
  TextEncoder,
  MutationObserver: FakeMutationObserver,
  Map,
  Set,
  Promise,
  Number,
  String,
  Array,
  Object,
  Math,
  Date,
  RegExp,
  Error,
  isFinite,
  console,
  setTimeout,
  clearTimeout,
};
vm.runInNewContext(instrumented, context, { filename: scriptPath });

const request = new Request(
  'https://jellium.test/Videos/item/item/Subtitles/2/0/Stream.js',
);
context.window.__jelliumSubtitleTest.start(request, nativeFetch);

await new Promise((resolve) => setTimeout(resolve, 700));
assert.equal(subtitleRequests, 1, 'initial subtitle window should be fetched');
assert.ok(track.cues.length > 0, 'initial subtitle cues should be attached');

video.currentTime = 18;
listeners.get('timeupdate')?.();
await new Promise((resolve) => setTimeout(resolve, 20));
assert.equal(subtitleRequests, 2, '2x playback should prefetch the next window');

video.currentTime = 60;
listeners.get('seeked')?.();
await new Promise((resolve) => setTimeout(resolve, 700));
assert.equal(subtitleRequests, 3, 'seek outside the loaded window should replace it');
assert.ok(track.cues.length >= 2, 'the replacement subtitle window should append cues');
assert.ok(
  track.cues.every((cue) => cue.text.startsWith('cue-3-')),
  'a stale append response must not survive a seek replacement',
);

const cueCountBeforeRebind = track.cues.length;
context.window.__jelliumSubtitleTest.session().attachedCueCount = 0;
await new Promise((resolve) => setTimeout(resolve, 700));
assert.equal(track.cues.length, cueCountBeforeRebind, 'rebinding must not duplicate cues');

for (const timer of Array.from(timers)) {
  window.clearInterval(timer);
}
assert.equal(timers.size, 0, 'runtime test timers must be cleaned up');
console.log('Jellium progressive subtitle runtime test passed');
process.exit(0);
