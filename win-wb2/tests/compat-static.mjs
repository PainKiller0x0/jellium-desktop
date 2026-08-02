import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const scriptPath = path.resolve('resources/jellyfin-web/jellium-series-compat.js');
const source = fs.readFileSync(scriptPath, 'utf8');

// This is intentionally dependency-free. The compatibility layer is injected into
// Jellyfin Web, so this smoke test protects its loading contract without pretending
// that a Node DOM is equivalent to WebView2.
assert.doesNotThrow(
  () => new vm.Script(source, { filename: scriptPath }),
  'the injected compatibility layer must remain valid JavaScript',
);

for (const marker of [
  'function installFetchCompatibility()',
  'function normalizeMetadataResponse',
  'function installOverviewDomFallback',
  'function withEpisodeFields',
  'function cacheGet',
  'function cachePut',
  'function cacheClear',
  'url.searchParams.sort()',
  'function metadataCacheEntryCanServeStale',
  '先返回旧内容并后台刷新',
  'Promise.all([countPromise, detailFieldsPromise])',
  'function coalescedApiItemRequest',
  'function coalescedApiEpisodeRequest',
  'function attachProgressiveSubtitleTrack',
  'session.cues = []',
  'progressive subtitle track rebound',
  'function progressiveSubtitleUrlAt',
  'function progressiveSubtitlePrefetchLeadSeconds',
  'function maybeAdvanceProgressiveSubtitle',
  "subtitleHeaders.set('Accept', 'text/vtt')",
  'PROGRESSIVE_SUBTITLE_WINDOW_SECONDS',
  'session.loadedFrom',
  'video.playbackRate',
  "video.addEventListener('timeupdate', session.timeUpdateHandler)",
  'currentTime - 5',
  "'seek-advance'",
  'if (session.video.seeking)',
  'streamCompleted = true',
  'if (!append) {',
  'clearProgressiveSubtitleCues(track);',
  "video.addEventListener('seeking', session.seekedHandler)",
  "'advance'",
  'session.loading = false',
  'window.fetch = compatibleFetch',
  'X-Jellium-Series-Compat',
  'prototype.getEpisodes = function',
  'prototype.getItems = function',
  'jellium-series-debug',
]) {
  assert.ok(source.includes(marker), `compatibility marker missing: ${marker}`);
}

// Debug URLs are allowed to expose endpoint names, never query values such as
// tokens, cookies, or signed download URLs.
assert.match(
  source,
  /function debugUrl\(value\)[\s\S]*?searchParams\.keys\(\)/,
  'debug output should keep query values out of the diagnostic panel',
);

console.log(`Jellium compatibility smoke passed: ${scriptPath}`);
