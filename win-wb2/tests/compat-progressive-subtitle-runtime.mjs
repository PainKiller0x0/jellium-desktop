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
  const ticks = Number((url.match(/Subtitles\/2\/(\d+)\/Stream\.vtt/) || [])[1] || 0);
  const start = ticks / 10000000;
  const vtt = [
    'WEBVTT',
    '',
    `${(start + 1).toFixed(3)} --> ${(start + 3).toFixed(3)}`,
    `cue-${subtitleRequests}-a`,
    '',
    `${(start + 10).toFixed(3)} --> ${(start + 12).toFixed(3)}`,
    `cue-${subtitleRequests}-b`,
    '',
  ].join('\n');
  return new Response(vtt, {
    status: 200,
    headers: { 'Content-Type': 'text/vtt' },
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

video.currentTime = 8;
listeners.get('timeupdate')?.();
await new Promise((resolve) => setTimeout(resolve, 700));
assert.equal(subtitleRequests, 2, '2x playback should prefetch the next window');
assert.ok(track.cues.length > 2, 'next subtitle window should append cues');
const cueCountBeforeRebind = track.cues.length;
context.window.__jelliumSubtitleTest.session().attachedCueCount = 0;
await new Promise((resolve) => setTimeout(resolve, 700));
assert.equal(track.cues.length, cueCountBeforeRebind, 'rebinding must not duplicate cues');

for (const timer of timers) {
  window.clearInterval(timer);
}
console.log('Jellium progressive subtitle runtime test passed');
