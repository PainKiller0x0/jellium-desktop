import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const scriptPath = path.resolve('resources/jellyfin-web/jellium-series-compat.js');
const source = fs.readFileSync(scriptPath, 'utf8');
const instrumented = source.replace(
  /\n\}\)\(\);\s*$/,
  `
    window.__jelliumHomePlaybackTest = {
        dedupe: dedupeHomeItemsPayload,
        rewrite: rewritePlaybackInfoPayload,
        installMediaSourceProxy: installMediaSourceProxy,
        clearExternalPlaybackState: clearExternalPlaybackState
    };
})();
`,
);

const storage = new Map();
const resumePayload = {
  Items: [
    {
      Id: 'quark-item',
      Type: 'Episode',
      Name: '空中城塞',
      SeriesName: '无职转生～到了异世界就拿出真本事～',
      ParentIndexNumber: 3,
      IndexNumber: 8,
      ProductionYear: 2023,
      Path: '/media/番/无职转生/Season 3/quark.strm',
      MediaSourceCount: 1,
      MediaSources: [{
        Id: 'myquark',
        Path: 'https://smartstrm.test/myquark/demo.strm',
        DirectStreamUrl: 'https://smartstrm.test/myquark/demo.mp4',
      }],
      UserData: { PlaybackPositionTicks: 100 },
    },
    {
      Id: 'xunlei-item',
      Type: 'Episode',
      Name: '空中城塞',
      SeriesName: '无职转生～到了异世界就拿出真本事～',
      ParentIndexNumber: 3,
      IndexNumber: 8,
      ProductionYear: 2023,
      Path: '/media/迅雷-番/无职转生/Season 3/xunlei.strm',
      MediaSourceCount: 1,
      MediaSources: [{
        Id: 'xunlei_737763560',
        Path: 'https://smartstrm.test/xunlei_737763560/demo.strm',
        DirectStreamUrl: 'https://smartstrm.test/xunlei_737763560/demo.mp4',
      }],
      UserData: { PlaybackPositionTicks: 200 },
    },
  ],
  TotalRecordCount: 2,
};

const playbackPayload = {
  MediaSources: [
    {
      Id: 'myquark',
      Path: 'https://smartstrm.test/myquark/demo.strm',
      DirectStreamUrl: 'https://smartstrm.test/myquark/demo.mp4',
      Container: 'mp4',
      IsRemote: true,
    },
    {
      Id: 'xunlei_737763560',
      Path: 'https://smartstrm.test/xunlei_737763560/demo.strm',
      DirectStreamUrl: 'https://smartstrm.test/xunlei_737763560/demo.mp4',
      Container: 'mp4',
      IsRemote: true,
    },
  ],
};

const diskCache = new Map();
const fetchUrls = [];
const nativeFetch = async (input, init = {}) => {
  const url = input.url || String(input);
  fetchUrls.push(url);
  const parsed = new URL(url);
  if (parsed.pathname.endsWith('/PlaybackInfo')) {
    return new Response(JSON.stringify(playbackPayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (parsed.pathname.endsWith('/Items/Resume')) {
    return new Response(JSON.stringify(resumePayload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
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
      diskCache.set(key, JSON.parse(init.body));
      return new Response('', { status: 204 });
    }
  }
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};

const document = {
  documentElement: { appendChild() {} },
  body: { appendChild(node) { node.isConnected = true; } },
  querySelector() { return null; },
  querySelectorAll() { return []; },
  getElementById(id) {
    if (id === 'jellium-settings-entry' || id === 'jellium-settings-modal' || id === 'jellium-settings-sidebar-entry') {
      return null;
    }
    return {
      checked: false,
      disabled: false,
      hidden: false,
      textContent: '',
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
      classList: { add() {}, remove() {}, contains() { return false; } },
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
  fetch: nativeFetch,
  console,
};

const context = {
  window,
  document,
  URL,
  URLSearchParams,
  Request,
  Response,
  Headers,
  AbortController,
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
  setInterval,
  clearInterval,
};
vm.runInNewContext(instrumented, context, { filename: scriptPath });

const directResult = context.window.__jelliumHomePlaybackTest.dedupe(
  resumePayload,
  'resume',
);
assert.equal(directResult.removed, 1);
assert.equal(directResult.payload.Items.length, 1);
assert.equal(directResult.payload.Items[0].Id, 'xunlei-item');
assert.deepEqual(
  Array.from(directResult.payload.Items[0].MediaSources, source => source.Id),
  ['xunlei_737763560', 'myquark'],
  'Xunlei should be the preferred source while Quark remains the fallback',
);

const resumeResponse = await context.window.fetch(
  new Request('https://jellium.test/Users/user/Items/Resume?Limit=24'),
);
const normalizedResume = await resumeResponse.json();
assert.equal(normalizedResume.Items.length, 1, 'Resume endpoint should not render duplicate source items');
assert.equal(normalizedResume.Items[0].MediaSourceCount, 2);

window.ApiClient = {
  accessToken() { return 'test-api-key'; },
  deviceId() { return 'jellium-test'; },
};
const playbackResponse = await context.window.fetch(
  new Request('https://jellium.test/Items/xunlei-item/PlaybackInfo', { method: 'POST' }),
);
const normalizedPlayback = await playbackResponse.json();
const xunleiSource = normalizedPlayback.MediaSources.find(source => source.Id === 'xunlei_737763560');
assert.ok(xunleiSource, 'the Xunlei source should remain available');
assert.match(
  xunleiSource.Path,
  /^https:\/\/smartstrm\.test\/xunlei_737763560\/demo\.strm$/,
  'versioned Xunlei playback should use the SmartStrm direct source',
);
assert.equal(xunleiSource.IsRemote, false);
assert.equal(
  xunleiSource.DirectStreamUrl,
  'https://smartstrm.test/xunlei_737763560/demo.mp4',
  'the direct playback URL should stay on SmartStrm',
);
assert.match(
  context.window.__jelliumExternalPlayback.url,
  /^https:\/\/jellium\.test\/__jellium\/redirect-stream\?/,
  'the external-player fallback should keep using the local redirect',
);
assert.equal(normalizedPlayback.MediaSources[0].Id, 'xunlei_737763560');

fetchUrls.length = 0;
await context.window.fetch(new Request(xunleiSource.Path, {
  headers: { Range: 'bytes=0-1048575' },
}));
assert.equal(
  fetchUrls.at(-1),
  xunleiSource.DirectStreamUrl,
  'media fetches should follow the SmartStrm direct URL instead of relaying bytes through jellyfin-rs',
);

context.window.__jelliumHomePlaybackTest.clearExternalPlaybackState('test cleanup');
assert.equal(
  context.window.__jelliumExternalPlayback,
  null,
  'external-player state should be cleared after a handoff',
);

class FakeMedia {
  constructor() {
    this._src = '';
    this.paused = true;
    this.currentTime = 0;
    this.listeners = new Map();
  }

  get src() {
    return this._src;
  }

  set src(value) {
    this._src = String(value);
  }

  get currentSrc() {
    return this._src;
  }

  setAttribute(name, value) {
    if (String(name).toLowerCase() === 'src') {
      this.src = value;
    }
  }

  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }

  removeEventListener(name, listener) {
    if (this.listeners.get(name) === listener) {
      this.listeners.delete(name);
    }
  }

  dispatchEvent(event) {
    const listener = this.listeners.get(event.type);
    if (listener) {
      listener.call(this, event);
    }
  }

  load() {}

  play() {
    return Promise.resolve();
  }
}

window.HTMLMediaElement = FakeMedia;
context.window.__jelliumHomePlaybackTest.installMediaSourceProxy();
const media = new FakeMedia();
media.src = xunleiSource.Path;
assert.match(
  media.src,
  /^https:\/\/smartstrm\.test\/xunlei_737763560\/demo\.mp4$/,
  'in-app playback should use the SmartStrm direct URL',
);
media.dispatchEvent({ type: 'error' });
assert.equal(
  media.src.startsWith('https://jellium.test/Videos/xunlei-item/xunlei_737763560/stream.mp4?'),
  true,
  'a failed SmartStrm source should fall back to the source-aware same-origin proxy',
);

console.log('Jellium home deduplication and Xunlei playback runtime regression test passed');
process.exit(0);
