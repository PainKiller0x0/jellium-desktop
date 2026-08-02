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

const storage = new Map();
const payload = {
  TrackEvents: [
    {
      StartPositionTicks: 1_000_000,
      EndPositionTicks: 3_000_000,
      Text: 'hello subtitle',
    },
  ],
};
let subtitleRequests = 0;
const nativeFetch = async (input) => {
  subtitleRequests += 1;
  assert.match(input.url || String(input), /\/Subtitles\/2\/Stream\.js$/);
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const document = {
  documentElement: { appendChild() {} },
  body: null,
  querySelector() { return null; },
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

const request = new Request(
  'https://jellium.test/Videos/item/item/Subtitles/2/Stream.js',
);
const response = await context.window.fetch(request);
assert.equal(subtitleRequests, 1, 'the real subtitle response should be fetched once');
assert.equal(response.status, 200);
assert.deepEqual(await response.json(), payload, 'TrackEvents must reach Jellyfin Web');
assert.equal(
  context.window.__jelliumSubtitleTest.session(),
  null,
  'passthrough mode must not leave a stale progressive session running',
);
console.log('Jellium subtitle passthrough regression test passed');
process.exit(0);
