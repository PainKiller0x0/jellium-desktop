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
        progressiveSession: function () { return progressiveSubtitleSession; },
        overlaySession: function () { return overlaySubtitleSession; },
        advanceOverlay: maybeAdvanceOverlaySubtitle,
        renderOverlay: renderOverlaySubtitle,
        bindOverlay: bindOverlaySubtitleVideo
    };
})();
`,
);

const storage = new Map();
const payload = {
  TrackEvents: [
    {
      StartPositionTicks: 1_000_000,
      EndPositionTicks: 3_000_000,
      Text: '<b>hello subtitle</b>',
    },
    {
      // Simulate the same cue returned by two overlapping subtitle windows
      // with a small timestamp drift.
      StartPositionTicks: 1_100_000,
      EndPositionTicks: 3_100_000,
      Text: 'hello subtitle',
    },
  ],
};
let subtitleRequests = 0;
const subtitleUrls = [];
const diskCache = new Map();
const nativeFetch = async (input, init = {}) => {
  const url = input.url || String(input);
  const parsed = new URL(url);
  if (parsed.pathname === '/__jellium/metadata-cache') {
    const action = parsed.searchParams.get('action');
    const key = parsed.searchParams.get('key');
    if (action === 'get') {
      const entry = diskCache.get(key);
      return entry
        ? new Response(JSON.stringify(entry), { status: 200, headers: { 'Content-Type': 'application/json' } })
        : new Response('{}', { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    if (action === 'put') {
      const entry = JSON.parse(init.body);
      diskCache.set(entry.key, entry);
      return new Response('', { status: 204 });
    }
  }
  subtitleRequests += 1;
  subtitleUrls.push(url);
  assert.match(url, /\/Subtitles\/2\/(?:\d+\/)?Stream\.js$/);
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

let activeVideo = null;
const document = {
  documentElement: { appendChild() {} },
  body: {
    appendChild(node) { node.isConnected = true; },
  },
  querySelector() { return activeVideo; },
  querySelectorAll() { return []; },
  getElementById(id) {
    if (id === 'jellium-settings-modal') return null;
    return {
      checked: false,
      disabled: false,
      style: {},
      parentElement: { insertBefore() {} },
      nextSibling: null,
      addEventListener() {},
      setAttribute() {},
      remove() {},
    };
  },
  createElement() {
    return {
      style: {},
      isConnected: false,
      setAttribute() {},
      addEventListener() {},
      appendChild() {},
      remove() {},
    };
  },
  addEventListener() {},
};

const window = {
  localStorage: {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, String(value)); },
  },
  location: new URL('https://jellium.test/'),
  addEventListener() {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  // The compatibility layer must preserve the actual server response for
  // Jellyfin Web's native and custom subtitle renderers.
  fetch: nativeFetch,
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
  MutationObserver: class { observe() {} disconnect() {} },
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

const animationFrames = [];
window.requestAnimationFrame = callback => {
  animationFrames.push(callback);
  return animationFrames.length;
};
window.cancelAnimationFrame = () => {};

const request = new Request(
  'https://jellium.test/Videos/item/item/Subtitles/2/Stream.js',
);
const response = await context.window.fetch(request);
assert.equal(
  subtitleRequests,
  0,
  'the official Edge renderer must receive an empty response without a competing request',
);
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), { TrackEvents: [] });
const session = context.window.__jelliumSubtitleTest.overlaySession();
assert.ok(session, 'a supplemental overlay session should follow the initial window');
assert.equal(
  context.window.__jelliumSubtitleTest.progressiveSession(),
  null,
  'the TextTrack renderer must stay disabled to prevent duplicate subtitles',
);
assert.equal(session.loadedFrom, 0);
assert.equal(session.loadedUntil, 0);
assert.equal(session.officialWindowUntil, 0);

activeVideo = {
  currentTime: 300,
  playbackRate: 2,
  seeking: false,
  paused: false,
  ended: false,
  textTracks: [{ kind: 'subtitles', mode: 'showing' }],
  addEventListener() {},
  removeEventListener() {},
};
context.window.__jelliumSubtitleTest.bindOverlay(session, activeVideo);
assert.equal(activeVideo.textTracks[0].mode, 'disabled', 'the native subtitle layer must stay disabled');
context.window.__jelliumSubtitleTest.advanceOverlay(session);
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(subtitleRequests, 1, 'resume must request a supplemental subtitle window');
assert.match(
  subtitleUrls[0],
  /\/Subtitles\/2\/2950000000\/Stream\.js$/,
  'resume at 300 seconds must request the window beginning 5 seconds earlier',
);
assert.equal(session.cues[0]?.text, 'hello subtitle', 'overlay strips embedded HTML tags');
session.video.currentTime = 0.15;
context.window.__jelliumSubtitleTest.renderOverlay(session);
assert.equal(
  session.overlay?.textContent,
  'hello subtitle',
  'overlapping duplicate cues must render only once',
);
activeVideo.currentTime = 0.35;
animationFrames.shift()?.();
assert.equal(
  session.overlay?.textContent,
  '',
  'the render loop must follow the media clock between timeupdate events',
);

const secondResponse = await context.window.fetch(request);
assert.deepEqual(await secondResponse.json(), { TrackEvents: [] });
const secondSession = context.window.__jelliumSubtitleTest.overlaySession();
activeVideo.currentTime = 300;
secondSession.video = activeVideo;
context.window.__jelliumSubtitleTest.advanceOverlay(secondSession);
await new Promise(resolve => setTimeout(resolve, 10));
assert.equal(subtitleRequests, 1, 'a persisted subtitle window must bypass the media server');
assert.equal(secondSession.cues[0]?.text, 'hello subtitle', 'the persisted window is rendered normally');
console.log('Jellium supplemental subtitle runtime regression test passed');
process.exit(0);
