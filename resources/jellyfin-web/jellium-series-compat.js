(function () {
    'use strict';

    var DEBUG_KEY = 'jellium-debug';
    var METADATA_CACHE_KEY = 'jellium-metadata-cache';
    var HIDE_CONTINUE_AUDIO_READING_KEY = 'jellium-hide-continue-audio-reading';
    var PLAYBACK_RATE_KEY = 'jellium-playback-rate';
    var CACHE_VERSION = 'v6';
    var HOST_CACHE_PATH = '/__jellium/metadata-cache';
    var MAX_DEBUG_LINES = 80;
    var MAX_CACHE_RESPONSE_BYTES = 4 * 1024 * 1024;
    var METADATA_CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;
    var VOLATILE_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
    var MAX_MEMORY_METADATA_ENTRIES = 256;
    var PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
    var debugLines = [];
    var cacheStats = { hits: 0, misses: 0, writes: 0 };
    var memoryMetadataCache = new Map();
    var metadataCacheLookups = new Map();
    var metadataInFlight = new Map();
    var progressiveSubtitleSession = null;
    var progressiveSubtitleSequence = 0;

    function getLocalSetting(key, fallback) {
        try {
            var value = window.localStorage && window.localStorage.getItem(key);
            return value == null ? fallback : value;
        } catch (_) {
            return fallback;
        }
    }

    function setLocalSetting(key, value) {
        try {
            if (window.localStorage) {
                window.localStorage.setItem(key, value);
            }
        } catch (_) {
            // Settings are best-effort and must never affect playback.
        }
    }

    function isDebugEnabled() {
        return getLocalSetting(DEBUG_KEY, '0') === '1';
    }

    function isMetadataCacheEnabled() {
        return getLocalSetting(METADATA_CACHE_KEY, '1') !== '0';
    }

    function isHideContinueAudioReadingEnabled() {
        return getLocalSetting(HIDE_CONTINUE_AUDIO_READING_KEY, '0') === '1';
    }

    function debugUrl(value) {
        try {
            var url = new URL(value, window.location.href);
            return url.pathname + '?keys=' + Array.from(url.searchParams.keys()).join(',');
        } catch (_) {
            return '<invalid-url>';
        }
    }

    function renderDebugPanel() {
        try {
            var panel = document.getElementById('jellium-series-debug');
            if (!isDebugEnabled()) {
                if (panel) {
                    panel.remove();
                }
                return;
            }
            if (!panel && document.documentElement) {
                panel = document.createElement('pre');
                panel.id = 'jellium-series-debug';
                panel.style.cssText = [
                    'position:fixed', 'right:8px', 'bottom:54px', 'z-index:2147483647',
                    'width:560px', 'max-width:calc(100vw - 24px)',
                    'max-height:240px', 'overflow:auto', 'margin:0',
                    'padding:8px', 'border:1px solid #35a7ff', 'border-radius:4px',
                    'background:rgba(8,12,20,.94)', 'color:#9fe7ff',
                    'font:11px/1.35 Consolas,monospace', 'white-space:pre-wrap',
                    'pointer-events:none', 'box-sizing:border-box'
                ].join(';');
                document.documentElement.appendChild(panel);
            }
            if (panel) {
                panel.textContent = debugLines.join('\n');
            }
        } catch (_) {
            // Debug output must never affect playback or page rendering.
        }
    }

    function debug(message) {
        if (!isDebugEnabled()) {
            return;
        }
        var text = '[jellium-series] ' + message;
        debugLines.push(text);
        if (debugLines.length > MAX_DEBUG_LINES) {
            debugLines.shift();
        }
        if (window.console && typeof window.console.info === 'function') {
            window.console.info(text);
        }
        try {
            window.__jelliumSeriesCompatLog = debugLines.slice();
        } catch (_) {
            // Ignore environments that expose a read-only window object.
        }
        renderDebugPanel();
    }

    function setDebugEnabled(enabled) {
        setLocalSetting(DEBUG_KEY, enabled ? '1' : '0');
        if (enabled) {
            debug('调试记录已启用');
        } else {
            renderDebugPanel();
        }
    }

    function hostCacheUrl(action, key) {
        var url = new URL(HOST_CACHE_PATH, window.location.origin);
        url.searchParams.set('action', action);
        if (key != null) {
            url.searchParams.set('key', key);
        }
        return url.toString();
    }

    function cacheGet(key) {
        return window.fetch(hostCacheUrl('get', key), {
            method: 'GET',
            headers: { Accept: 'application/json' },
            cache: 'no-store'
        }).then(function (response) {
            if (response.status === 404) {
                return null;
            }
            if (!response.ok) {
                throw new Error('host cache read failed: ' + response.status);
            }
            return response.json();
        });
    }

    function cachePut(entry) {
        return window.fetch(hostCacheUrl('put'), {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            cache: 'no-store',
            body: JSON.stringify(entry)
        }).then(function (response) {
            if (!response.ok) {
                throw new Error('host cache write failed: ' + response.status);
            }
            cacheStats.writes += 1;
        });
    }

    function cacheClear() {
        return window.fetch(hostCacheUrl('clear'), {
            method: 'DELETE',
            cache: 'no-store'
        }).then(function (response) {
            if (!response.ok) {
                throw new Error('host cache clear failed: ' + response.status);
            }
            cacheStats.hits = 0;
            cacheStats.misses = 0;
            cacheStats.writes = 0;
            debug('刮削缓存已清空');
        });
    }

    function cacheCount() {
        return window.fetch(hostCacheUrl('count'), {
            method: 'GET',
            headers: { Accept: 'application/json' },
            cache: 'no-store'
        }).then(function (response) {
            if (!response.ok) {
                throw new Error('host cache count failed: ' + response.status);
            }
            return response.json();
        }).then(function (value) {
            return Number(value && value.count) || 0;
        });
    }

    function metadataCacheKey(request) {
        var url = new URL(request.url, window.location.href);
        // Jellyfin changes this cutoff on every home-page refresh even though
        // the underlying Next Up query is otherwise identical. Keeping it in
        // the key defeats the persistent cache and makes cold starts rebuild
        // the same home section over and over.
        if (/\/Shows\/NextUp$/i.test(url.pathname)) {
            url.searchParams.delete('NextUpDateCutoff');
        }
        return CACHE_VERSION + ':' + url.toString();
    }

    function legacyMetadataCacheKey(request) {
        return CACHE_VERSION + ':' + request.url;
    }

    function metadataCacheLookup(request, key) {
        var legacyKey = legacyMetadataCacheKey(request);
        return cacheGet(key).then(function (entry) {
            if (entry || legacyKey === key) {
                return entry;
            }
            // Migrate the old timestamped Next Up entry lazily so the first
            // optimized launch can still reuse the cache from older builds.
            return cacheGet(legacyKey).then(function (legacyEntry) {
                if (!legacyEntry || typeof legacyEntry.body !== 'string') {
                    return null;
                }
                var migrated = Object.assign({}, legacyEntry, { key: key });
                cachePut(migrated).catch(function (error) {
                    debug('缓存键迁移失败=' + (error && error.message || String(error)));
                });
                return migrated;
            });
        });
    }

    function metadataCacheMaxAge(request) {
        try {
            var url = new URL(request.url, window.location.href);
            if (
                /\/Items\/Latest$/i.test(url.pathname) ||
                /\/Shows\/(NextUp|Upcoming)$/i.test(url.pathname) ||
                /\/Search\/Hints$/i.test(url.pathname) ||
                /\/Items\/Resume$/i.test(url.pathname)
            ) {
                return VOLATILE_CACHE_MAX_AGE_MS;
            }
        } catch (_) {
            // Fall back to the general metadata lifetime.
        }
        return METADATA_CACHE_MAX_AGE_MS;
    }

    function isCacheableMetadataRequest(request) {
        if (!request || request.method !== 'GET') {
            return false;
        }
        var url;
        try {
            url = new URL(request.url, window.location.href);
        } catch (_) {
            return false;
        }
        var path = url.pathname;
        if (
            /\/(Images|PlaybackInfo|Videos|Sessions|Playback|Playing|SyncPlay|ScheduledTasks|Tasks|Notifications)(\/|$)/i.test(path) ||
            /\/Authenticate(ByName)?(\/|$)/i.test(path)
        ) {
            return false;
        }
        if (!/(\/Items(?:\/|$)|\/Shows(?:\/|$)|\/Search\/Hints|\/Genres(?:\/|$)|\/Persons(?:\/|$)|\/Studios(?:\/|$)|\/Artists(?:\/|$)|\/MusicGenres(?:\/|$)|\/RemoteImages(?:\/|$))/i.test(path)) {
            return false;
        }
        var accept = request.headers && request.headers.get('accept');
        return !accept || /json|\*\/\*/i.test(accept);
    }

    function responseFromCache(entry) {
        var headers = new Headers(entry.headers || {});
        headers.set('X-Jellium-Metadata-Cache', 'HIT');
        return new Response(entry.body, {
            status: entry.status || 200,
            statusText: entry.statusText || '',
            headers: headers
        });
    }

    function metadataCacheEntryIsFresh(entry, request) {
        if (!entry || typeof entry.body !== 'string') {
            return false;
        }
        var age = Math.max(0, Date.now() - (Number(entry.updatedAt) || 0));
        return age <= metadataCacheMaxAge(request);
    }

    function memoryMetadataCacheGet(key, request) {
        var entry = memoryMetadataCache.get(key);
        if (!entry) {
            return null;
        }
        if (!metadataCacheEntryIsFresh(entry, request)) {
            memoryMetadataCache.delete(key);
            return null;
        }
        // Reinsert to approximate LRU without maintaining a second list.
        memoryMetadataCache.delete(key);
        memoryMetadataCache.set(key, entry);
        return entry;
    }

    function memoryMetadataCachePut(key, entry) {
        if (!entry || typeof entry.body !== 'string') {
            return;
        }
        memoryMetadataCache.delete(key);
        memoryMetadataCache.set(key, entry);
        while (memoryMetadataCache.size > MAX_MEMORY_METADATA_ENTRIES) {
            var oldestKey = memoryMetadataCache.keys().next().value;
            memoryMetadataCache.delete(oldestKey);
        }
    }

    function metadataEntryFromResponse(key, response) {
        if (!response || !response.ok) {
            return Promise.resolve(null);
        }
        var contentType = response.headers.get('content-type') || '';
        if (!/json/i.test(contentType)) {
            return Promise.resolve(null);
        }
        return response.clone().text().then(function (body) {
            if (body.length > MAX_CACHE_RESPONSE_BYTES) {
                debug('跳过过大的元数据响应 bytes=' + body.length);
                return null;
            }
            return {
                key: key,
                body: body,
                status: response.status,
                statusText: response.statusText,
                headers: {
                    'content-type': contentType,
                    'content-language': response.headers.get('content-language') || ''
                },
                updatedAt: Date.now()
            };
        }).catch(function () {
            // A response that cannot be cloned/read is still valid for the caller.
            return null;
        });
    }

    function startMetadataNetworkFetch(key, request, networkFetch, staleEntry) {
        var responsePromise = networkFetch();
        var entryPromise = responsePromise.then(function (response) {
            if (!response.ok) {
                return staleEntry || null;
            }
            return metadataEntryFromResponse(key, response).then(function (entry) {
                if (!entry) {
                    return null;
                }
                memoryMetadataCachePut(key, entry);
                // The caller must not wait for disk persistence. The memory entry
                // is enough to coalesce concurrent requests in this page load.
                cachePut(entry).catch(function (error) {
                    debug('缓存异步写入失败=' + (error && error.message || String(error)));
                });
                return entry;
            }).catch(function () {
                return null;
            });
        }).catch(function () {
            return staleEntry || null;
        });

        metadataInFlight.set(key, entryPromise);
        entryPromise.then(function () {
            if (metadataInFlight.get(key) === entryPromise) {
                metadataInFlight.delete(key);
            }
        });

        return responsePromise.then(function (response) {
            if (!response.ok && staleEntry) {
                return responseFromCache(staleEntry);
            }
            return response;
        }).catch(function (error) {
            if (staleEntry) {
                return responseFromCache(staleEntry);
            }
            throw error;
        });
    }

    function fetchWithMetadataCache(request, networkFetch) {
        if (!isMetadataCacheEnabled() || !isCacheableMetadataRequest(request)) {
            return networkFetch();
        }
        var key = metadataCacheKey(request);
        var memoryEntry = memoryMetadataCacheGet(key, request);
        if (memoryEntry) {
            cacheStats.hits += 1;
            debug('内存元数据缓存命中 ' + debugUrl(request.url));
            return Promise.resolve(responseFromCache(memoryEntry));
        }

        var inFlight = metadataInFlight.get(key);
        if (inFlight) {
            return inFlight.then(function (entry) {
                if (entry) {
                    cacheStats.hits += 1;
                    debug('合并重复元数据请求 ' + debugUrl(request.url));
                    return responseFromCache(entry);
                }
                return networkFetch();
            });
        }

        var lookup = metadataCacheLookups.get(key);
        if (!lookup) {
            lookup = metadataCacheLookup(request, key);
            metadataCacheLookups.set(key, lookup);
            lookup.then(function () {
                if (metadataCacheLookups.get(key) === lookup) {
                    metadataCacheLookups.delete(key);
                }
            }, function () {
                if (metadataCacheLookups.get(key) === lookup) {
                    metadataCacheLookups.delete(key);
                }
            });
        }

        return lookup.then(function (entry) {
            var cachedEntry = memoryMetadataCacheGet(key, request);
            if (cachedEntry) {
                cacheStats.hits += 1;
                debug('内存元数据缓存命中 ' + debugUrl(request.url));
                return responseFromCache(cachedEntry);
            }

            var pending = metadataInFlight.get(key);
            if (pending) {
                return pending.then(function (pendingEntry) {
                    if (pendingEntry) {
                        cacheStats.hits += 1;
                        debug('合并重复元数据请求 ' + debugUrl(request.url));
                        return responseFromCache(pendingEntry);
                    }
                    return networkFetch();
                });
            }

            if (metadataCacheEntryIsFresh(entry, request)) {
                memoryMetadataCachePut(key, entry);
                cacheStats.hits += 1;
                debug('元数据缓存命中 ' + debugUrl(request.url));
                return responseFromCache(entry);
            }

            if (entry && typeof entry.body === 'string') {
                debug('元数据缓存过期，重新拉取 ' + debugUrl(request.url));
            } else {
                cacheStats.misses += 1;
                debug('元数据缓存未命中 ' + debugUrl(request.url));
            }
            return startMetadataNetworkFetch(key, request, networkFetch, entry);
        }).catch(function (error) {
            debug('缓存读取失败=' + (error && error.message || String(error)) + '; 使用网络');
            return networkFetch();
        });
    }

    function refreshCacheStatus(element) {
        if (!element) {
            return;
        }
        cacheCount().then(function (count) {
            element.textContent = '当前已缓存 ' + count + ' 条元数据；命中 ' + cacheStats.hits + ' 次';
        }).catch(function () {
            element.textContent = '本地缓存暂不可用';
        });
    }

    function isContinueAudioReadingTitle(value) {
        var text = String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
        if (!text) {
            return false;
        }
        return [
            '继续收听', '继续阅读', '继续听书', '继续看书',
            'continue listening', 'continue reading', 'continue audiobooks',
            'continue audio', 'resume listening', 'resume reading'
        ].some(function (title) {
            return text === title || text.indexOf(title + ' ') === 0 || text.indexOf(title + ':') === 0;
        });
    }

    function findContinueSectionContainer(node) {
        var current = node;
        for (var depth = 0; current && depth < 8; depth += 1, current = current.parentElement) {
            if (current.matches && current.matches('section, [role="region"], .verticalSection, .section, .itemsContainer')) {
                return current;
            }
            var className = typeof current.className === 'string' ? current.className : '';
            if (/verticalSection|sectionContainer|itemsContainer/i.test(className)) {
                return current;
            }
        }
        return node.parentElement || node;
    }

    function applyContinueSectionVisibility() {
        var hidden = isHideContinueAudioReadingEnabled();
        var headings = document.querySelectorAll('h1, h2, h3, [role="heading"], .sectionTitle, .sectionTitleText');
        Array.prototype.forEach.call(headings, function (heading) {
            var container = findContinueSectionContainer(heading);
            if (!container) {
                return;
            }
            if (isContinueAudioReadingTitle(heading.textContent)) {
                container.classList.toggle('jellium-hidden-continue-audio-reading', hidden);
            }
        });
        if (!hidden) {
            Array.prototype.forEach.call(
                document.querySelectorAll('.jellium-hidden-continue-audio-reading'),
                function (element) {
                    element.classList.remove('jellium-hidden-continue-audio-reading');
                }
            );
        }
    }

    function installContinueSectionVisibility() {
        if (window.__jelliumContinueVisibilityInstalled) {
            applyContinueSectionVisibility();
            return;
        }
        window.__jelliumContinueVisibilityInstalled = true;
        applyContinueSectionVisibility();
        if (!window.MutationObserver || !document.documentElement) {
            return;
        }
        var scheduled = false;
        var observer = new MutationObserver(function () {
            if (scheduled) {
                return;
            }
            scheduled = true;
            window.setTimeout(function () {
                scheduled = false;
                applyContinueSectionVisibility();
            }, 80);
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.__jelliumContinueVisibilityObserver = observer;
    }

    function findNativeSettingsLink() {
        var candidates = Array.prototype.slice.call(document.querySelectorAll('a, button'));
        return candidates.find(function (element) {
            if (element.id === 'jellium-settings-sidebar-entry') {
                return false;
            }
            var label = (element.textContent || '').replace(/\s+/g, ' ').trim();
            return label === '设置' || label === 'Settings';
        }) || null;
    }

    function replaceClonedSettingsLabel(entry) {
        var label = entry.querySelector('.navMenuOptionText, .navMenuOptionTextInner, [data-role="label"]');
        if (label) {
            label.textContent = 'Jellium 设置';
            return;
        }
        var leaves = Array.prototype.filter.call(entry.querySelectorAll('*'), function (node) {
            return !node.children.length &&
                !node.classList.contains('material-icons') &&
                (node.textContent || '').trim();
        });
        if (leaves.length) {
            leaves[leaves.length - 1].textContent = 'Jellium 设置';
        } else {
            entry.appendChild(document.createTextNode('Jellium 设置'));
        }
    }

    function installSidebarSettingsEntry() {
        var oldFloating = document.getElementById('jellium-settings-entry');
        if (oldFloating) {
            oldFloating.remove();
        }
        if (!document.body || document.getElementById('jellium-settings-sidebar-entry')) {
            return !!document.getElementById('jellium-settings-sidebar-entry');
        }
        var nativeSettings = findNativeSettingsLink();
        if (!nativeSettings || !nativeSettings.parentElement) {
            return false;
        }

        var entry = nativeSettings.cloneNode(true);
        entry.id = 'jellium-settings-sidebar-entry';
        entry.title = 'Jellium 设置';
        entry.setAttribute('aria-label', 'Jellium 设置');
        if (entry.tagName === 'A') {
            entry.setAttribute('href', '#jellium-settings');
        } else {
            entry.type = 'button';
        }
        replaceClonedSettingsLabel(entry);
        entry.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            if (typeof window.__jelliumOpenSettings === 'function') {
                window.__jelliumOpenSettings();
            }
        });
        nativeSettings.parentElement.insertBefore(entry, nativeSettings.nextSibling);
        return true;
    }

    function watchSidebarSettingsEntry() {
        if (window.__jelliumSidebarSettingsObserver || !document.documentElement) {
            return;
        }
        var observer = new MutationObserver(function () {
            if (!document.getElementById('jellium-settings-sidebar-entry')) {
                installSidebarSettingsEntry();
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        window.__jelliumSidebarSettingsObserver = observer;
    }

    function installSettingsUi() {
        if (!document.documentElement) {
            return;
        }
        var oldFloating = document.getElementById('jellium-settings-entry');
        if (oldFloating) {
            oldFloating.remove();
        }
        if (document.getElementById('jellium-settings-modal')) {
            installSidebarSettingsEntry();
            watchSidebarSettingsEntry();
            return;
        }

        var style = document.createElement('style');
        style.id = 'jellium-settings-style';
        style.textContent = [
            '#jellium-settings-sidebar-entry{cursor:pointer}',
            '#jellium-settings-modal{position:fixed;inset:0;z-index:2147483645;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.58);font:14px/1.45 Arial,sans-serif;color:#e7edf7}',
            '#jellium-settings-modal[hidden]{display:none}',
            '.jellium-settings-card{width:420px;max-width:calc(100vw - 32px);border:1px solid #3c526d;border-radius:8px;background:#111a28;box-shadow:0 12px 50px rgba(0,0,0,.55);padding:20px}',
            '.jellium-settings-card h2{margin:0 0 18px;font-size:20px;color:#fff}',
            '.jellium-settings-row{display:flex;gap:10px;align-items:flex-start;margin:15px 0}',
            '.jellium-settings-row input{width:18px;height:18px;margin-top:2px;accent-color:#35a7ff}',
            '.jellium-settings-row label{font-weight:600;color:#fff}',
            '.jellium-settings-help{display:block;margin-top:3px;color:#9db0c7;font-size:12px;font-weight:400}',
            '.jellium-settings-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:20px}',
            '.jellium-settings-actions button{border:1px solid #4a6685;border-radius:4px;background:#1a2b40;color:#e7edf7;padding:7px 12px;cursor:pointer}',
            '.jellium-settings-actions button:hover{background:#25577e}',
            '.jellium-settings-actions .danger{border-color:#9a5860;color:#ffdfe3}',
            '#jellium-cache-status{margin-top:8px;color:#9db0c7;font-size:12px}',
            '.jellium-hidden-continue-audio-reading{display:none!important}'
        ].join('');
        document.documentElement.appendChild(style);

        var modal = document.createElement('div');
        modal.id = 'jellium-settings-modal';
        modal.hidden = true;
        modal.innerHTML = [
            '<div class="jellium-settings-card" role="dialog" aria-modal="true" aria-labelledby="jellium-settings-title">',
            '<h2 id="jellium-settings-title">Jellium 设置</h2>',
            '<div class="jellium-settings-row"><input id="jellium-debug-toggle" type="checkbox"><div><label for="jellium-debug-toggle">打开调试记录</label><span class="jellium-settings-help">开启后在右下角显示最近的请求与兼容层日志。</span></div></div>',
            '<div class="jellium-settings-row"><input id="jellium-cache-toggle" type="checkbox"><div><label for="jellium-cache-toggle">本地保存刮削内容</label><span class="jellium-settings-help">缓存名称、简介、剧集列表等元数据到 Jellium 目录的 jellium-cache；播放、进度和视频流不会缓存。</span><div id="jellium-cache-status">正在读取缓存状态…</div></div></div>',
            '<div class="jellium-settings-row"><input id="jellium-hide-continue-toggle" type="checkbox"><div><label for="jellium-hide-continue-toggle">隐藏继续收听 &amp; 继续阅读</label><span class="jellium-settings-help">隐藏首页对应的音频和阅读推荐区，不影响继续观看。</span></div></div>',
            '<div class="jellium-settings-actions"><button id="jellium-cache-clear" class="danger" type="button">清空刮削缓存</button><button id="jellium-settings-close" type="button">关闭</button></div>',
            '</div>'
        ].join('');
        document.documentElement.appendChild(modal);

        var debugToggle = document.getElementById('jellium-debug-toggle');
        var cacheToggle = document.getElementById('jellium-cache-toggle');
        var hideContinueToggle = document.getElementById('jellium-hide-continue-toggle');
        var status = document.getElementById('jellium-cache-status');
        var clearButton = document.getElementById('jellium-cache-clear');
        var closeButton = document.getElementById('jellium-settings-close');

        function syncSettings() {
            debugToggle.checked = isDebugEnabled();
            cacheToggle.checked = isMetadataCacheEnabled();
            hideContinueToggle.checked = isHideContinueAudioReadingEnabled();
            applyContinueSectionVisibility();
            refreshCacheStatus(status);
        }

        function closeSettings() {
            modal.hidden = true;
        }

        closeButton.addEventListener('click', closeSettings);
        modal.addEventListener('click', function (event) {
            if (event.target === modal) {
                closeSettings();
            }
        });
        debugToggle.addEventListener('change', function () {
            setDebugEnabled(debugToggle.checked);
        });
        cacheToggle.addEventListener('change', function () {
            setLocalSetting(METADATA_CACHE_KEY, cacheToggle.checked ? '1' : '0');
            debug('刮削缓存已' + (cacheToggle.checked ? '启用' : '停用'));
            refreshCacheStatus(status);
        });
        hideContinueToggle.addEventListener('change', function () {
            setLocalSetting(HIDE_CONTINUE_AUDIO_READING_KEY, hideContinueToggle.checked ? '1' : '0');
            debug('继续收听/阅读区域已' + (hideContinueToggle.checked ? '隐藏' : '显示'));
            applyContinueSectionVisibility();
        });
        clearButton.addEventListener('click', function () {
            clearButton.disabled = true;
            clearButton.textContent = '清理中…';
            cacheClear().then(function () {
                status.textContent = '缓存已清空';
            }).catch(function () {
                status.textContent = '缓存清理失败';
            }).then(function () {
                clearButton.disabled = false;
                clearButton.textContent = '清空刮削缓存';
            });
        });

        window.__jelliumOpenSettings = function () {
            syncSettings();
            modal.hidden = false;
        };
        installSidebarSettingsEntry();
        watchSidebarSettingsEntry();
    }

    function playbackRateLabel(rate) {
        var value = Number(rate);
        if (!isFinite(value)) {
            value = 1;
        }
        return (Math.round(value * 100) / 100).toString() + '×';
    }

    function getPlaybackRate() {
        var value = Number(getLocalSetting(PLAYBACK_RATE_KEY, '1'));
        if (!isFinite(value)) {
            return 1;
        }
        var nearest = PLAYBACK_RATES[0];
        PLAYBACK_RATES.forEach(function (rate) {
            if (Math.abs(rate - value) < Math.abs(nearest - value)) {
                nearest = rate;
            }
        });
        return nearest;
    }

    function applyPlaybackRate(rate) {
        var normalized = Number(rate);
        if (!isFinite(normalized)) {
            normalized = 1;
        }
        var changed = getPlaybackRate() !== normalized;
        setLocalSetting(PLAYBACK_RATE_KEY, String(normalized));
        Array.prototype.forEach.call(document.querySelectorAll('video, audio'), function (media) {
            try {
                if (Math.abs(Number(media.playbackRate) - normalized) > 0.01) {
                    media.playbackRate = normalized;
                    changed = true;
                }
                if (Math.abs(Number(media.defaultPlaybackRate) - normalized) > 0.01) {
                    media.defaultPlaybackRate = normalized;
                }
            } catch (_) {
                // Some media elements reject rate changes before metadata loads.
            }
            if (!media.__jelliumPlaybackRateBound) {
                media.__jelliumPlaybackRateBound = true;
                media.addEventListener('loadedmetadata', function () {
                    try {
                        media.playbackRate = getPlaybackRate();
                        media.defaultPlaybackRate = getPlaybackRate();
                    } catch (_) {
                        // Best effort; the next control refresh will retry.
                    }
                });
            }
        });
        updatePlaybackRateButtons();
        if (changed) {
            debug('播放倍速=' + playbackRateLabel(normalized));
        }
    }

    function updatePlaybackRateButtons() {
        var label = playbackRateLabel(getPlaybackRate());
        Array.prototype.forEach.call(
            document.querySelectorAll('#jellium-playback-speed, #jellium-playback-speed-floating'),
            function (button) {
                button.textContent = label;
                button.title = '播放速度：' + label + '（点击切换）';
                button.setAttribute('aria-label', '播放速度 ' + label);
            }
        );
    }

    function createPlaybackRateButton(floating) {
        var button = document.createElement('button');
        button.id = floating ? 'jellium-playback-speed-floating' : 'jellium-playback-speed';
        button.type = 'button';
        button.className = floating ? 'jellium-playback-speed-fallback' : 'btnVideoOsdSpeed autoSize';
        button.textContent = playbackRateLabel(getPlaybackRate());
        button.title = '播放速度：' + playbackRateLabel(getPlaybackRate()) + '（点击切换）';
        button.setAttribute('aria-label', '播放速度 ' + playbackRateLabel(getPlaybackRate()));
        button.addEventListener('click', function (event) {
            event.preventDefault();
            event.stopPropagation();
            var current = getPlaybackRate();
            var index = PLAYBACK_RATES.indexOf(current);
            var next = PLAYBACK_RATES[(index + 1) % PLAYBACK_RATES.length];
            applyPlaybackRate(next);
        });
        return button;
    }

    function ensurePlaybackRateButton() {
        var media = document.querySelector('video');
        var existing = document.getElementById('jellium-playback-speed');
        var floating = document.getElementById('jellium-playback-speed-floating');
        if (!media) {
            if (existing) {
                existing.remove();
            }
            if (floating) {
                floating.remove();
            }
            return;
        }

        var controls = document.querySelector('.videoOsdBottom .buttons');
        if (controls) {
            if (floating) {
                floating.remove();
            }
            if (!existing) {
                existing = createPlaybackRateButton(false);
                var settingsButton = controls.querySelector('.btnVideoOsdSettings');
                if (settingsButton) {
                    controls.insertBefore(existing, settingsButton);
                } else {
                    controls.appendChild(existing);
                }
            }
        } else if (!floating) {
            floating = createPlaybackRateButton(true);
            floating.style.cssText = [
                'position:fixed', 'right:24px', 'bottom:76px', 'z-index:2147483644',
                'border:1px solid rgba(255,255,255,.7)', 'border-radius:4px',
                'background:rgba(18,28,43,.94)', 'color:#fff', 'padding:7px 10px',
                'font:600 13px/1.2 Arial,sans-serif', 'cursor:pointer'
            ].join(';');
            document.documentElement.appendChild(floating);
        }
        applyPlaybackRate(getPlaybackRate());
        updatePlaybackRateButtons();
    }

    function installPlaybackRateUi() {
        if (window.__jelliumPlaybackRateInstalled) {
            ensurePlaybackRateButton();
            return;
        }
        window.__jelliumPlaybackRateInstalled = true;
        ensurePlaybackRateButton();
        if (window.MutationObserver && document.documentElement) {
            var scheduled = false;
            var observer = new MutationObserver(function () {
                if (scheduled) {
                    return;
                }
                scheduled = true;
                window.setTimeout(function () {
                    scheduled = false;
                    ensurePlaybackRateButton();
                }, 100);
            });
            observer.observe(document.documentElement, { childList: true, subtree: true });
            window.__jelliumPlaybackRateObserver = observer;
        }
        window.setInterval(ensurePlaybackRateButton, 700);
    }

    function installPlaybackDiagnostics() {
        if (window.__jelliumPlaybackDiagnosticsInstalled) {
            return;
        }
        window.__jelliumPlaybackDiagnosticsInstalled = true;
        var bindMedia = function (media) {
            if (!media || media.__jelliumPlaybackDiagnosticsBound) {
                return;
            }
            media.__jelliumPlaybackDiagnosticsBound = true;
            ['loadstart', 'loadedmetadata', 'canplay', 'playing', 'waiting', 'stalled', 'emptied', 'error'].forEach(function (eventName) {
                media.addEventListener(eventName, function () {
                    var error = media.error;
                    debug('媒体事件=' + eventName +
                        ' ready=' + media.readyState +
                        ' network=' + media.networkState +
                        ' error=' + (error ? error.code : 0) +
                        ' src=' + debugUrl(media.currentSrc || media.src || ''));
                });
            });
        };
        var scan = function () {
            Array.prototype.forEach.call(document.querySelectorAll('video, audio'), bindMedia);
        };
        scan();
        if (window.MutationObserver && document.documentElement) {
            var observer = new MutationObserver(scan);
            observer.observe(document.documentElement, { childList: true, subtree: true });
            window.__jelliumPlaybackDiagnosticsObserver = observer;
        }
        window.addEventListener('error', function (event) {
            if (event && event.message) {
                debug('页面错误=' + event.message);
            }
        });
        window.addEventListener('unhandledrejection', function (event) {
            var reason = event && event.reason;
            debug('未处理异步错误=' + (reason && reason.message || String(reason || 'unknown')));
        });
    }

    debug('compat script loaded');
    installSettingsUi();
    installContinueSectionVisibility();
    installPlaybackRateUi();
    installPlaybackDiagnostics();

    // Jellyfin Web generates collection-style /movies and /tv links for some
    // Movie and Episode cards. jellyfin-rs exposes those items directly, so
    // following the generated link opens an empty child listing. Resolve the
    // target once and replace only playable leaf items with their detail page.
    function redirectPlayableCollectionRoute() {
        var rawHash = window.location.hash || '';
        var route;
        try {
            route = new URL(rawHash.replace(/^#/, '') || '/', window.location.origin);
        } catch (_) {
            return;
        }
        if (route.pathname !== '/movies' && route.pathname !== '/tv') {
            return;
        }
        var itemId = route.searchParams.get('topParentId');
        var client = window.ApiClient;
        var userId = client && client.getCurrentUserId && client.getCurrentUserId();
        if (!itemId || !client || typeof client.getItem !== 'function' || !userId) {
            return;
        }
        client.getItem(userId, itemId).then(function (item) {
            if (
                (item && item.Type === 'Movie') ||
                (item && item.Type === 'Episode')
            ) {
                // A navigation may have completed while getItem was in flight.
                // Never redirect a route the user has already left.
                if (window.location.hash === rawHash) {
                    debug('redirect playable ' + item.Type + ' route id=' + String(itemId).slice(-8));
                    // The generated /movies or /tv route is only an intermediate
                    // Jellyfin-Web link. Replace it instead of adding another
                    // history entry, so Back returns to the library that the
                    // user came from rather than revisiting the dead route.
                    window.location.replace('#/details?id=' + encodeURIComponent(itemId));
                }
            }
        }).catch(function (error) {
            debug('playable route resolve failed=' + (error && error.message || String(error)));
        });
    }

    function installPlayableCollectionRouteRedirect() {
        document.addEventListener('click', function (event) {
            var target = event.target;
            var anchor = target && target.closest && target.closest('a[href]');
            if (!anchor) {
                return;
            }
            var type = anchor.dataset && anchor.dataset.type;
            var href = anchor.getAttribute('href') || '';
            if ((type !== 'Movie' && type !== 'Episode') || !/topParentId=/.test(href)) {
                return;
            }
            var route;
            try {
                route = new URL(href.replace(/^#/, '') || '/', window.location.origin);
            } catch (_) {
                return;
            }
            var itemId = route.searchParams.get('topParentId') ||
                (anchor.dataset && anchor.dataset.id);
            if (!itemId) {
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            debug('intercept playable ' + type + ' click id=' + String(itemId).slice(-8));
            // Do not leave the generated collection route in browser history.
            // Otherwise Back lands on /movies?topParentId=... and the fallback
            // redirect immediately opens this same detail page again.
            window.location.replace('#/details?id=' + encodeURIComponent(itemId));
        }, true);
        // Only repair a collection route that was present when the app opened.
        // Running this after every hash/popstate also catches the route produced
        // by Back from a detail page and creates a redirect loop.
        window.setTimeout(redirectPlayableCollectionRoute, 0);
    }

    installPlayableCollectionRouteRedirect();

    function isSeriesChildrenUrl(value) {
        var url;
        try {
            url = new URL(value, window.location.href);
        } catch (_) {
            return null;
        }

        var segments = url.pathname.split('/').filter(Boolean);
        if (
            segments.length !== 3 ||
            segments[0] !== 'Users' ||
            segments[2] !== 'Items'
        ) {
            return null;
        }

        var itemTypes = String(url.searchParams.get('IncludeItemTypes') || '')
            .split(',')
            .map(function (value) { return value.trim(); })
            .filter(Boolean);
        if (!itemTypes.some(function (value) {
            // Jellyfin Web may ask for a season's episodes as generic Video
            // items.  jellyfin-rs exposes the enriched Episode DTOs through
            // /Shows/{seriesId}/Episodes, so Video must follow the same path.
            return value === 'Series' || value === 'Season' || value === 'Episode' || value === 'Video';
        })) {
            return null;
        }

        var parentId = url.searchParams.get('ParentId');
        if (!parentId) {
            return null;
        }
        return {
            url: url,
            userId: segments[1],
            parentId: parentId,
            itemTypes: itemTypes
        };
    }

    function removeListOnlyParams(url) {
        ['ParentId', 'IncludeItemTypes', 'Recursive', 'SortBy', 'SortOrder'].forEach(function (key) {
            url.searchParams.delete(key);
        });
    }

    function rewriteSeriesChildrenUrl(requestUrl, parent) {
        var rewritten = new URL(requestUrl.toString());
        removeListOnlyParams(rewritten);
        rewritten.searchParams.delete('userId');
        rewritten.searchParams.set('UserId', parent.userId);

        if (parent.item.Type === 'Series') {
            var wantsEpisodes = parent.itemTypes && (
                parent.itemTypes.indexOf('Episode') >= 0 || parent.itemTypes.indexOf('Video') >= 0
            );
            rewritten.pathname = '/Shows/' + encodeURIComponent(parent.item.Id || parent.parentId) +
                (wantsEpisodes ? '/Episodes' : '/Seasons');
            return rewritten;
        }

        if (parent.item.Type === 'Season' && parent.item.SeriesId) {
            rewritten.pathname = '/Shows/' + encodeURIComponent(parent.item.SeriesId) + '/Episodes';
            rewritten.searchParams.set('SeasonId', parent.item.Id || parent.parentId);
            return rewritten;
        }

        return null;
    }

    function isItemDetailUrl(value) {
        var url;
        try {
            url = new URL(value, window.location.href);
        } catch (_) {
            return null;
        }
        var segments = url.pathname.split('/').filter(Boolean);
        if (!segments.length || !segments[segments.length - 1]) {
            return null;
        }
        if (segments.length === 4 && segments[0] === 'Users' && segments[2] === 'Items') {
            return { url: url, userId: segments[1], itemId: segments[3] };
        }
        if (segments.length === 2 && segments[0] === 'Items') {
            return {
                url: url,
                userId: url.searchParams.get('UserId') || url.searchParams.get('userId') || '',
                itemId: segments[1]
            };
        }
        return null;
    }

    function detailRequestUrl(origin, path, userId) {
        var url = new URL(path, origin);
        if (userId) {
            url.searchParams.set('UserId', userId);
        }
        return url;
    }

    function isPositiveCount(value) {
        var number = Number(value);
        return isFinite(number) && number > 0;
    }

    function hasOverview(item) {
        return !!(item && typeof item.Overview === 'string' && item.Overview.trim());
    }

    function withEpisodeFields(query) {
        var result = Object.assign({}, query || {});
        var fields = String(result.Fields || '')
            .split(',')
            .map(function (value) { return value.trim(); })
            .filter(Boolean);
        var seen = {};
        fields.forEach(function (value) { seen[value.toLowerCase()] = true; });
        [
            'Overview',
            'SeriesId',
            'ParentId',
            'SeasonName',
            'PrimaryImageAspectRatio',
            'MediaSourceCount',
            'IndexNumber',
            'ParentIndexNumber',
            'PremiereDate',
            'ProductionYear',
            'ProviderIds'
        ].forEach(function (field) {
            if (!seen[field.toLowerCase()]) {
                fields.push(field);
                seen[field.toLowerCase()] = true;
            }
        });
        result.Fields = fields.join(',');
        return result;
    }

    function currentDetailItemId() {
        var values = [window.location.search || '', window.location.hash || ''];
        for (var i = 0; i < values.length; i += 1) {
            var value = values[i];
            var match = /(?:[?#&]|^)id=([^&#]+)/i.exec(value);
            if (match && match[1]) {
                try {
                    return decodeURIComponent(match[1]);
                } catch (_) {
                    return match[1];
                }
            }
        }
        var routeMatch = /(?:^|[#/])details[/?]([^?&#/]+)/i.exec(window.location.hash || window.location.pathname || '');
        if (routeMatch && routeMatch[1]) {
            try {
                return decodeURIComponent(routeMatch[1]);
            } catch (_) {
                return routeMatch[1];
            }
        }
        return '';
    }

    function rememberApiItem(item) {
        if (!item || !item.Id) {
            return;
        }
        try {
            window.__jelliumSeriesCompatItems = window.__jelliumSeriesCompatItems || {};
            window.__jelliumSeriesCompatItems[item.Id] = item;
        } catch (_) {
            // Best-effort diagnostic bridge for the DOM fallback below.
        }
    }

    function renderRememberedEpisodeOverview() {
        var itemId = currentDetailItemId();
        if (!itemId || !window.__jelliumSeriesCompatItems) {
            return;
        }
        var item = window.__jelliumSeriesCompatItems[itemId];
        if (!item || item.Type !== 'Episode' || !hasOverview(item)) {
            return;
        }
        var nodes = document.querySelectorAll('.overview');
        if (!nodes.length) {
            return;
        }
        var changed = 0;
        nodes.forEach(function (node) {
            if (!node.textContent || !node.textContent.trim() || node.classList.contains('hide')) {
                node.textContent = item.Overview.trim();
                node.classList.remove('hide');
                node.classList.add('detail-clamp-text');
                node.style.display = 'block';
                node.style.color = 'inherit';
                changed += 1;
            }
        });
        if (changed) {
            debug('episode overview DOM fallback rendered id=' + String(itemId).slice(-8));
        }
    }

    function installOverviewDomFallback() {
        if (!window.MutationObserver || !document.documentElement) {
            return;
        }
        var scheduled = false;
        var schedule = function () {
            if (scheduled) {
                return;
            }
            scheduled = true;
            window.setTimeout(function () {
                scheduled = false;
                renderRememberedEpisodeOverview();
            }, 80);
        };
        new MutationObserver(schedule).observe(document.documentElement, {
            childList: true,
            subtree: true
        });
        window.addEventListener('hashchange', schedule);
        window.setInterval(renderRememberedEpisodeOverview, 700);
    }

    function jsonResponseLike(response, payload) {
        var headers = new Headers(response.headers || {});
        if (!headers.get('content-type')) {
            headers.set('content-type', 'application/json; charset=utf-8');
        }
        return new Response(JSON.stringify(payload), {
            status: response.status,
            statusText: response.statusText,
            headers: headers
        });
    }

    // The compatibility layer sometimes needs a second metadata request to
    // fill in counts or episode overviews. Those requests used to go straight
    // through nativeFetch, so they bypassed both the disk cache and the
    // in-flight request coalescer. Reuse the same cache path here, while still
    // keeping the original fetch function so this helper cannot recurse into
    // the compatibility wrapper.
    function supplementalMetadataFetch(nativeFetch, url, init) {
        var request;
        try {
            request = new Request(url, init);
        } catch (_) {
            return nativeFetch(url, init);
        }
        return fetchWithMetadataCache(request, function () {
            return nativeFetch(request);
        });
    }

    function isDirectShowSeasonsUrl(value) {
        var url;
        try {
            url = new URL(value, window.location.href);
        } catch (_) {
            return null;
        }
        var segments = url.pathname.split('/').filter(Boolean);
        if (segments.length !== 3 || segments[0] !== 'Shows' || segments[2] !== 'Seasons') {
            return null;
        }
        return { url: url, seriesId: segments[1] };
    }

    function fallbackEmptyShowSeasons(request, response, nativeFetch) {
        var show = isDirectShowSeasonsUrl(request.url);
        if (!show || !response || !response.ok) {
            return Promise.resolve(response);
        }
        return response.clone().json().then(function (payload) {
            if (!payload || !Array.isArray(payload.Items) || payload.Items.length !== 0) {
                return response;
            }
            var episodesUrl = new URL(show.url.toString());
            episodesUrl.pathname = '/Shows/' + encodeURIComponent(show.seriesId) + '/Episodes';
            debug('direct seasons empty; fallback ' + debugUrl(episodesUrl));
            return supplementalMetadataFetch(nativeFetch, episodesUrl.toString(), {
                method: 'GET',
                headers: request.headers,
                credentials: request.credentials,
                cache: 'no-store',
                signal: request.signal
            }).then(function (episodeResponse) {
                debug('direct episode fallback status=' + episodeResponse.status);
                return episodeResponse;
            });
        }).catch(function () {
            return response;
        });
    }

    function removeNestedSeriesFromList(request, response, nativeFetch) {
        var list = isSeriesChildrenUrl(request.url);
        if (!list || list.itemTypes.indexOf('Series') < 0 || !response || !response.ok) {
            return Promise.resolve(response);
        }
        return response.clone().json().then(function (payload) {
            if (!payload || !Array.isArray(payload.Items) || payload.Items.length === 0) {
                return response;
            }
            var parentIds = [];
            var seen = {};
            payload.Items.forEach(function (item) {
                if (item && item.Type === 'Series' && item.ParentId && !seen[item.ParentId]) {
                    seen[item.ParentId] = true;
                    parentIds.push(item.ParentId);
                }
            });
            if (!parentIds.length) {
                return response;
            }
            return Promise.all(parentIds.map(function (parentId) {
                var parentUrl = new URL(
                    '/Users/' + encodeURIComponent(list.userId) + '/Items/' + encodeURIComponent(parentId),
                    list.url.origin
                );
                return supplementalMetadataFetch(nativeFetch, parentUrl.toString(), {
                    method: 'GET',
                    headers: request.headers,
                    credentials: request.credentials,
                    cache: 'no-store',
                    signal: request.signal
                }).then(function (parentResponse) {
                    if (!parentResponse.ok) {
                        return { id: parentId, type: '' };
                    }
                    return parentResponse.json().then(function (parent) {
                        return { id: parentId, type: parent && parent.Type || '' };
                    });
                }).catch(function () {
                    return { id: parentId, type: '' };
                });
            })).then(function (parents) {
                var seriesParents = {};
                parents.forEach(function (parent) {
                    if (parent.type === 'Series') {
                        seriesParents[parent.id] = true;
                    }
                });
                var filtered = payload.Items.filter(function (item) {
                    return !(item && item.Type === 'Series' && seriesParents[item.ParentId]);
                });
                if (filtered.length === payload.Items.length) {
                    return response;
                }
                var removedCount = payload.Items.length - filtered.length;
                payload.Items = filtered;
                if (payload.TotalRecordCount != null) {
                    var total = Number(payload.TotalRecordCount);
                    if (isFinite(total)) {
                        payload.TotalRecordCount = Math.max(0, total - removedCount);
                    }
                }
                debug('removed nested Series cards count=' + removedCount);
                return jsonResponseLike(response, payload);
            });
        }).catch(function () {
            return response;
        });
    }

    function enrichEpisodeListOverviews(request, response, nativeFetch) {
        if (!response || !response.ok) {
            return Promise.resolve(response);
        }
        var url;
        try {
            url = new URL(request.url, window.location.href);
        } catch (_) {
            return Promise.resolve(response);
        }
        var segments = url.pathname.split('/').filter(Boolean);
        var showSeriesId = segments.length === 3 && segments[0] === 'Shows' && segments[2] === 'Episodes'
            ? segments[1]
            : '';
        var list = isSeriesChildrenUrl(request.url);
        var isEpisodeList = !!showSeriesId || !!(list && list.itemTypes.indexOf('Episode') >= 0);
        if (!isEpisodeList) {
            return Promise.resolve(response);
        }
        return response.clone().json().then(function (payload) {
            if (!payload || !Array.isArray(payload.Items) || !payload.Items.length) {
                return response;
            }
            var missing = payload.Items.filter(function (item) {
                return item && item.Type === 'Episode' && !hasOverview(item);
            });
            if (!missing.length) {
                return response;
            }
            var seriesId = showSeriesId || (missing[0] && missing[0].SeriesId) ||
                (payload.Items[0] && payload.Items[0].SeriesId);
            if (!seriesId) {
                return response;
            }
            var userId = (list && list.userId) || url.searchParams.get('UserId') ||
                url.searchParams.get('userId') || '';
            var seriesPath = userId
                ? '/Users/' + encodeURIComponent(userId) + '/Items/' + encodeURIComponent(seriesId)
                : '/Items/' + encodeURIComponent(seriesId);
            var seriesUrl = new URL(seriesPath, url.origin);
            return supplementalMetadataFetch(nativeFetch, seriesUrl.toString(), {
                method: 'GET',
                headers: request.headers,
                credentials: request.credentials,
                cache: 'no-store',
                signal: request.signal
            }).then(function (seriesResponse) {
                if (!seriesResponse.ok) {
                    return response;
                }
                return seriesResponse.json().then(function (series) {
                    if (!hasOverview(series)) {
                        return response;
                    }
                    var enrichedCount = 0;
                    payload.Items.forEach(function (item) {
                        if (
                            item &&
                            item.Type === 'Episode' &&
                            !hasOverview(item) &&
                            (showSeriesId || !item.SeriesId || item.SeriesId === seriesId)
                        ) {
                            item.Overview = series.Overview;
                            item.SeriesOverview = series.Overview;
                            enrichedCount += 1;
                        }
                    });
                    if (!enrichedCount) {
                        return response;
                    }
                    debug('episode list overview fallback count=' + enrichedCount +
                        ' series=' + String(seriesId).slice(-8));
                    return jsonResponseLike(response, payload);
                });
            });
        }).catch(function () {
            return response;
        });
    }

    function normalizeMetadataResponse(request, response, nativeFetch) {
        return augmentItemDetailResponse(request, response, nativeFetch).then(function (normalized) {
            return removeNestedSeriesFromList(request, normalized, nativeFetch).then(function (withoutNested) {
                return enrichEpisodeListOverviews(request, withoutNested, nativeFetch);
            });
        });
    }

    function apiResultData(result) {
        return result && result.data ? result.data : result;
    }

    function apiEpisodeCount(result) {
        var data = apiResultData(result);
        var total = Number(data && data.TotalRecordCount);
        if (isFinite(total)) {
            return total;
        }
        return data && Array.isArray(data.Items) ? data.Items.length : 0;
    }

    function normalizeApiItem(client, userId, item, originalGetItem, originalGetEpisodes) {
        if (!item || typeof item !== 'object') {
            return Promise.resolve(item);
        }
        var normalized = item;
        var tasks = [];

        if (
            item.Type === 'Series' &&
            !isPositiveCount(item.EpisodeCount) &&
            !isPositiveCount(item.RecursiveItemCount) &&
            !isPositiveCount(item.ChildCount) &&
            item.Id
        ) {
            tasks.push(originalGetEpisodes.call(client, item.Id, {
                userId: userId,
                Limit: 1
            }).then(function (result) {
                var count = apiEpisodeCount(result);
                if (count > 0) {
                    normalized = Object.assign({}, normalized, {
                        EpisodeCount: count,
                        RecursiveItemCount: count,
                        RecursiveUnplayedItemCount: isPositiveCount(item.RecursiveUnplayedItemCount)
                            ? item.RecursiveUnplayedItemCount
                            : 0,
                        // The custom child route exposes direct episodes as the
                        // contents when this series has no Season rows.
                        ChildCount: isPositiveCount(item.ChildCount) ? item.ChildCount : 1
                    });
                    debug('ApiClient series counts normalized episodes=' + count + ' child=1');
                }
            }).catch(function (error) {
                debug('ApiClient series count probe failed=' + (error && error.message || String(error)));
            }));
        }

        if (item.Type === 'Episode' && !hasOverview(item) && item.SeriesId) {
            tasks.push(originalGetItem.call(client, userId, item.SeriesId).then(function (series) {
                if (hasOverview(series)) {
                    normalized = Object.assign({}, normalized, {
                        Overview: series.Overview,
                        SeriesOverview: series.Overview
                    });
                    debug('ApiClient episode overview fallback from series id=' +
                        String(item.SeriesId).slice(-8));
                }
            }).catch(function (error) {
                debug('ApiClient episode overview fallback failed=' +
                    (error && error.message || String(error)));
            }));
        }

        return Promise.all(tasks).then(function () { return normalized; });
    }

    function normalizeApiEpisodeResult(client, userId, result, originalGetItem) {
        var data = apiResultData(result);
        if (!data || !Array.isArray(data.Items) || !data.Items.length) {
            return Promise.resolve(result);
        }
        var seriesIds = [];
        var seen = {};
        data.Items.forEach(function (item) {
            if (item && item.Type === 'Episode' && !hasOverview(item) && item.SeriesId && !seen[item.SeriesId]) {
                seen[item.SeriesId] = true;
                seriesIds.push(item.SeriesId);
            }
        });
        if (!seriesIds.length) {
            return Promise.resolve(result);
        }
        return Promise.all(seriesIds.map(function (seriesId) {
            return originalGetItem.call(client, userId, seriesId).then(function (series) {
                if (!hasOverview(series)) {
                    return;
                }
                data.Items.forEach(function (item) {
                    if (item && item.Type === 'Episode' && !hasOverview(item) && item.SeriesId === seriesId) {
                        item.Overview = series.Overview;
                        item.SeriesOverview = series.Overview;
                    }
                });
                debug('ApiClient episode list overview fallback series=' + String(seriesId).slice(-8));
            }).catch(function (error) {
                debug('ApiClient episode list overview failed=' +
                    (error && error.message || String(error)));
            });
        })).then(function () { return result; });
    }

    function augmentItemDetailResponse(request, response, nativeFetch) {
        var detail = isItemDetailUrl(request.url);
        if (!detail || !response || !response.ok) {
            return Promise.resolve(response);
        }
        var contentType = response.headers && response.headers.get('content-type') || '';
        if (contentType && !/json/i.test(contentType)) {
            return Promise.resolve(response);
        }

        return response.clone().json().then(function (item) {
            if (!item || typeof item !== 'object') {
                return response;
            }
            var changed = false;
            var itemType = String(item.Type || '');
            debug('detail type=' + (itemType || '<none>') +
                ' id=' + (item.Id ? String(item.Id).slice(-8) : String(detail.itemId).slice(-8)) +
                ' overview=' + (hasOverview(item) ? 'yes' : 'no'));

            var countPromise = Promise.resolve();
            if (
                itemType === 'Series' &&
                !isPositiveCount(item.EpisodeCount) &&
                !isPositiveCount(item.RecursiveItemCount) &&
                !isPositiveCount(item.ChildCount)
            ) {
                var episodesUrl = detailRequestUrl(
                    detail.url.origin,
                    '/Shows/' + encodeURIComponent(item.Id || detail.itemId) + '/Episodes',
                    detail.userId
                );
                episodesUrl.searchParams.set('Limit', '1');
                debug('series counts missing; probe ' + debugUrl(episodesUrl));
                countPromise = supplementalMetadataFetch(nativeFetch, episodesUrl.toString(), {
                    method: 'GET',
                    headers: request.headers,
                    credentials: request.credentials,
                    cache: 'no-store',
                    signal: request.signal
                }).then(function (countResponse) {
                    if (!countResponse.ok) {
                        debug('series count probe status=' + countResponse.status);
                        return;
                    }
                    return countResponse.json().then(function (payload) {
                        var count = Number(payload && payload.TotalRecordCount);
                        if (!isFinite(count)) {
                            count = payload && Array.isArray(payload.Items) ? payload.Items.length : 0;
                        }
                        if (count > 0) {
                            item.EpisodeCount = count;
                            item.RecursiveItemCount = count;
                            if (!isPositiveCount(item.ChildCount)) {
                                // The compatibility child route presents direct episodes
                                // as the series contents when there are no Season rows.
                                item.ChildCount = 1;
                            }
                            if (!isPositiveCount(item.RecursiveUnplayedItemCount)) {
                                item.RecursiveUnplayedItemCount = 0;
                            }
                            changed = true;
                            debug('series counts normalized episodes=' + count + ' child=1');
                        } else {
                            debug('series count probe returned 0');
                        }
                    });
                }).catch(function (error) {
                    debug('series count probe failed=' + (error && error.message || String(error)));
                });
            }

            var overviewPromise = countPromise;
            if (!hasOverview(item) && !detail.url.searchParams.get('jelliumDetailFields')) {
                var detailFieldsUrl = new URL(detail.url.toString());
                var detailFields = String(detailFieldsUrl.searchParams.get('Fields') || '')
                    .split(',')
                    .map(function (value) { return value.trim(); })
                    .filter(Boolean);
                [
                    'Overview',
                    'SeriesId',
                    'ParentId',
                    'SeasonName',
                    'IndexNumber',
                    'ParentIndexNumber',
                    'PremiereDate',
                    'ProductionYear',
                    'ProviderIds'
                ].forEach(function (field) {
                    if (detailFields.indexOf(field) < 0) {
                        detailFields.push(field);
                    }
                });
                detailFieldsUrl.searchParams.set('Fields', detailFields.join(','));
                // Keep this request separate from an older cache entry whose key
                // did not ask for the detail fields explicitly.
                detailFieldsUrl.searchParams.set('jelliumDetailFields', '1');
                overviewPromise = overviewPromise.then(function () {
                    return supplementalMetadataFetch(nativeFetch, detailFieldsUrl.toString(), {
                        method: 'GET',
                        headers: request.headers,
                        credentials: request.credentials,
                        cache: 'no-store',
                        signal: request.signal
                    }).then(function (fieldsResponse) {
                        if (!fieldsResponse.ok) {
                            debug('detail fields refresh status=' + fieldsResponse.status);
                            return;
                        }
                        return fieldsResponse.json().then(function (freshItem) {
                            if (!freshItem || typeof freshItem !== 'object') {
                                return;
                            }
                            Object.keys(freshItem).forEach(function (key) {
                                if (freshItem[key] != null) {
                                    item[key] = freshItem[key];
                                }
                            });
                            if (hasOverview(freshItem)) {
                                changed = true;
                                debug('detail fields refreshed overview=yes id=' +
                                    String(item.Id || detail.itemId).slice(-8));
                            }
                        });
                    }).catch(function (error) {
                        debug('detail fields refresh failed=' +
                            (error && error.message || String(error)));
                    });
                });
            }
            if (itemType === 'Episode' && !hasOverview(item) && item.SeriesId) {
                var seriesPath = detail.userId
                    ? '/Users/' + encodeURIComponent(detail.userId) + '/Items/' + encodeURIComponent(item.SeriesId)
                    : '/Items/' + encodeURIComponent(item.SeriesId);
                var seriesUrl = detailRequestUrl(detail.url.origin, seriesPath, null);
                overviewPromise = overviewPromise.then(function () {
                    return supplementalMetadataFetch(nativeFetch, seriesUrl.toString(), {
                        method: 'GET',
                        headers: request.headers,
                        credentials: request.credentials,
                        cache: 'no-store',
                        signal: request.signal
                    }).then(function (seriesResponse) {
                        if (!seriesResponse.ok) {
                            return;
                        }
                        return seriesResponse.json().then(function (series) {
                            if (hasOverview(series)) {
                                item.Overview = series.Overview;
                                item.SeriesOverview = series.Overview;
                                changed = true;
                                debug('episode overview fallback from series id=' + String(item.SeriesId).slice(-8));
                            }
                        });
                    });
                }).catch(function (error) {
                    debug('episode overview fallback failed=' + (error && error.message || String(error)));
                });
            }

            return overviewPromise.then(function () {
                return changed ? jsonResponseLike(response, item) : response;
            });
        }).catch(function (error) {
            debug('detail normalization skipped=' + (error && error.message || String(error)));
            return response;
        });
    }

    function isSubtitleJsonRequest(value) {
        try {
            return /\/Videos\/[^/]+\/(?:[^/]+\/)?Subtitles\/\d+(?:\/\d+)?\/Stream\.js$/i
                .test(new URL(value, window.location.href).pathname);
        } catch (_) {
            return false;
        }
    }

    function subtitleTimestampSeconds(value) {
        var parts = String(value || '').replace(',', '.').split(':');
        if (parts.length === 3) {
            return (parseFloat(parts[0]) * 3600) +
                (parseFloat(parts[1]) * 60) +
                parseFloat(parts[2]);
        }
        if (parts.length === 2) {
            return (parseFloat(parts[0]) * 60) + parseFloat(parts[1]);
        }
        return parseFloat(parts[0]);
    }

    function currentManualSubtitleTrack() {
        var video = document.querySelector('video.htmlvideoplayer, video');
        if (!video || !video.textTracks) {
            return null;
        }
        var tracks = Array.prototype.slice.call(video.textTracks);
        return tracks.find(function (track) {
            return String(track.label || '').indexOf('manualTrack') !== -1;
        }) || tracks[0] || null;
    }

    function addProgressiveSubtitleCue(session, block) {
        if (progressiveSubtitleSession !== session) {
            return;
        }
        var lines = String(block || '').replace(/\r/g, '').trim().split('\n');
        if (!lines.length || /^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/i.test(lines[0])) {
            return;
        }
        var timingIndex = lines.findIndex(function (line) {
            return line.indexOf('-->') !== -1;
        });
        if (timingIndex < 0) {
            return;
        }
        var timing = lines[timingIndex].match(
            /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/
        );
        if (!timing) {
            return;
        }
        var start = subtitleTimestampSeconds(timing[1]);
        var end = subtitleTimestampSeconds(timing[2]);
        var text = lines.slice(timingIndex + 1).join('\n');
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !text) {
            return;
        }
        var cueType = window.VTTCue || window.TextTrackCue;
        if (!cueType) {
            return;
        }
        var track = currentManualSubtitleTrack();
        if (!track) {
            session.pending.push({ start: start, end: end, text: text });
            return;
        }
        var pending = session.pending.splice(0);
        pending.push({ start: start, end: end, text: text });
        pending.forEach(function (value) {
            try {
                track.addCue(new cueType(value.start, value.end, value.text));
                session.cueCount += 1;
            } catch (error) {
                debug('progressive subtitle cue failed=' +
                    (error && error.message || String(error)));
            }
        });
        track.mode = 'showing';
        if (!session.firstCueLogged && session.cueCount > 0) {
            session.firstCueLogged = true;
            debug('progressive subtitle first cue ready in ' +
                Math.round(performance.now() - session.startedAt) + 'ms');
        }
    }

    function feedProgressiveSubtitle(session, value, done) {
        session.buffer += value.replace(/\r/g, '');
        var blocks = session.buffer.split(/\n{2,}/);
        if (!done) {
            session.buffer = blocks.pop() || '';
        } else {
            session.buffer = '';
        }
        blocks.forEach(function (block) {
            addProgressiveSubtitleCue(session, block);
        });
        if (done && session.pending.length) {
            var pending = session.pending.splice(0);
            pending.forEach(function (cue) {
                addProgressiveSubtitleCue(session,
                    cue.start + ' --> ' + cue.end + '\n' + cue.text);
            });
        }
    }

    function clearProgressiveSubtitleCues(track) {
        if (!track || !track.cues) {
            return;
        }
        while (track.cues.length) {
            try {
                track.removeCue(track.cues[0]);
            } catch (_) {
                break;
            }
        }
    }

    function progressiveSubtitleCueRange(track) {
        if (!track || !track.cues || !track.cues.length) {
            return null;
        }
        var first = Number.POSITIVE_INFINITY;
        var last = 0;
        for (var index = 0; index < track.cues.length; index += 1) {
            first = Math.min(first, Number(track.cues[index].startTime) || 0);
            last = Math.max(last, Number(track.cues[index].endTime) || 0);
        }
        return { first: first, last: last };
    }

    function progressiveSubtitleUrlAt(baseUrl, startSeconds) {
        var url = new URL(baseUrl);
        var ticks = Math.max(0, Math.floor((Number(startSeconds) || 0) * 10000000));
        url.pathname = url.pathname.replace(
            /(\/Videos\/[^/]+\/[^/]+\/Subtitles\/\d+)(?:\/\d+)?\/Stream\.vtt$/i,
            function (_, prefix) {
                return prefix + (ticks ? '/' + ticks : '') + '/Stream.vtt';
            }
        );
        return url;
    }

    function abortProgressiveSubtitleStream(session) {
        if (!session || !session.controller) {
            return;
        }
        try {
            session.controller.abort();
        } catch (_) {
            // The stream may already be complete.
        }
        session.controller = null;
    }

    function startProgressiveSubtitleStream(session, startSeconds, reason) {
        if (progressiveSubtitleSession !== session) {
            return;
        }
        abortProgressiveSubtitleStream(session);
        session.runId += 1;
        var runId = session.runId;
        session.buffer = '';
        session.pending = [];
        session.cueCount = 0;
        session.firstCueLogged = false;
        session.startedAt = performance.now();
        session.startSeconds = Math.max(0, Number(startSeconds) || 0);
        session.controller = new AbortController();
        var controller = session.controller;
        var track = currentManualSubtitleTrack();
        clearProgressiveSubtitleCues(track);
        if (track) {
            track.mode = 'showing';
        }

        var vttUrl = progressiveSubtitleUrlAt(session.baseVttUrl, session.startSeconds);
        debug('progressive subtitle start reason=' + reason +
            ' offset=' + session.startSeconds.toFixed(3) + 's ' + debugUrl(vttUrl));
        var decoder = new TextDecoder('utf-8');
        session.nativeFetch(vttUrl.toString(), {
            method: 'GET',
            headers: session.headers,
            credentials: session.credentials,
            cache: 'no-store',
            signal: controller.signal
        }).then(function (response) {
            if (!response.ok || !response.body) {
                throw new Error('subtitle stream status=' + response.status);
            }
            var reader = response.body.getReader();
            var pump = function () {
                return reader.read().then(function (part) {
                    if (progressiveSubtitleSession !== session || session.runId !== runId) {
                        return reader.cancel();
                    }
                    if (part.done) {
                        feedProgressiveSubtitle(session, decoder.decode(), true);
                        debug('progressive subtitle complete offset=' +
                            session.startSeconds.toFixed(3) + 's cues=' + session.cueCount);
                        return;
                    }
                    feedProgressiveSubtitle(
                        session,
                        decoder.decode(part.value, { stream: true }),
                        false
                    );
                    return pump();
                });
            };
            return pump();
        }).catch(function (error) {
            if ((!error || error.name !== 'AbortError') &&
                    progressiveSubtitleSession === session && session.runId === runId) {
                debug('progressive subtitle failed=' +
                    (error && error.message || String(error)));
            }
        });
    }

    function bindProgressiveSubtitleVideo(session, video) {
        if (!video || session.video === video) {
            return;
        }
        if (session.video && session.seekedHandler) {
            session.video.removeEventListener('seeked', session.seekedHandler);
        }
        session.video = video;
        session.seekedHandler = function () {
            session.lastSeekAt = Date.now();
            window.clearTimeout(session.seekTimer);
            session.seekTimer = window.setTimeout(function () {
                if (progressiveSubtitleSession !== session || !session.video) {
                    return;
                }
                var target = Number(session.video.currentTime) || 0;
                var range = progressiveSubtitleCueRange(currentManualSubtitleTrack());
                var covered = range && target >= range.first - 2 && target <= range.last + 2;
                debug('progressive subtitle seek target=' + target.toFixed(3) +
                    's range=' + (range ?
                        range.first.toFixed(3) + '-' + range.last.toFixed(3) : 'empty') +
                    ' covered=' + Boolean(covered));
                if (!covered) {
                    startProgressiveSubtitleStream(session, Math.max(0, target - 15), 'seek');
                }
            }, 120);
        };
        video.addEventListener('seeked', session.seekedHandler);
    }

    function stopProgressiveSubtitle(reason) {
        var session = progressiveSubtitleSession;
        if (!session) {
            return;
        }
        progressiveSubtitleSession = null;
        if (session.monitor) {
            window.clearInterval(session.monitor);
        }
        window.clearTimeout(session.seekTimer);
        if (session.video && session.seekedHandler) {
            session.video.removeEventListener('seeked', session.seekedHandler);
        }
        abortProgressiveSubtitleStream(session);
        if (reason) {
            debug('progressive subtitle stopped=' + reason +
                ' cues=' + session.cueCount);
        }
    }

    function progressiveSubtitleJsonResponse(request, nativeFetch) {
        stopProgressiveSubtitle('switch');

        var vttUrl = new URL(request.url);
        vttUrl.pathname = vttUrl.pathname
            .replace(/Stream\.js$/i, 'Stream.vtt')
            .replace(/(\/Subtitles\/\d+)\/\d+\/Stream\.vtt$/i, '$1/Stream.vtt');
        var session = {
            id: ++progressiveSubtitleSequence,
            runId: 0,
            controller: null,
            buffer: '',
            pending: [],
            cueCount: 0,
            firstCueLogged: false,
            startedAt: performance.now(),
            startSeconds: 0,
            baseVttUrl: vttUrl.toString(),
            nativeFetch: nativeFetch,
            headers: new Headers(request.headers),
            credentials: request.credentials,
            monitor: null,
            video: null,
            seekedHandler: null,
            seekTimer: null,
            lastSeekAt: 0
        };
        progressiveSubtitleSession = session;
        startProgressiveSubtitleStream(session, 0, 'selection');

        session.monitor = window.setInterval(function () {
            if (progressiveSubtitleSession !== session) {
                window.clearInterval(session.monitor);
                return;
            }
            var video = document.querySelector('video.htmlvideoplayer, video');
            if (!video) {
                stopProgressiveSubtitle('player closed');
                return;
            }
            bindProgressiveSubtitleVideo(session, video);
            var track = currentManualSubtitleTrack();
            if (track && track.mode === 'disabled' && session.cueCount > 0 &&
                    !video.seeking && Date.now() - session.lastSeekAt > 3000) {
                stopProgressiveSubtitle('subtitle disabled');
            }
        }, 500);

        return Promise.resolve(new Response(
            JSON.stringify({ TrackEvents: [] }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json; charset=utf-8' }
            }
        ));
    }

    function installFetchCompatibility() {
        if (typeof window.fetch !== 'function' || window.fetch.__jelliumSeriesCompatInstalled) {
            return false;
        }

        var nativeFetch = window.fetch.bind(window);
        var compatibleFetch = function (input, init) {
            var request;
            try {
                request = new Request(input, init);
            } catch (_) {
                return nativeFetch(input, init);
            }

            if (request.method === 'GET' && isSubtitleJsonRequest(request.url)) {
                return progressiveSubtitleJsonResponse(request, nativeFetch);
            }

            var networkFetch = function () {
                if (request.method !== 'GET') {
                    return nativeFetch(input, init);
                }
                var match = isSeriesChildrenUrl(request.url);
                if (!match) {
                    if (isDirectShowSeasonsUrl(request.url)) {
                        return nativeFetch(request).then(function (response) {
                            return fallbackEmptyShowSeasons(request, response, nativeFetch);
                        });
                    }
                    return nativeFetch(request);
                }

                debug('intercept ' + debugUrl(request.url));
                var parentUrl = new URL(
                    '/Users/' + encodeURIComponent(match.userId) + '/Items/' + encodeURIComponent(match.parentId),
                    match.url.origin
                );
                return nativeFetch(parentUrl.toString(), {
                    method: 'GET',
                    headers: request.headers,
                    credentials: request.credentials,
                    cache: 'no-store',
                    signal: request.signal
                }).then(function (response) {
                    debug('parent status=' + response.status + ' url=' + debugUrl(parentUrl));
                    if (!response.ok) {
                        debug('parent failed; fallback original request');
                        return nativeFetch(request);
                    }
                    return response.json().then(function (item) {
                        debug('parent type=' + (item && item.Type || '<none>') +
                            ' id=' + (item && item.Id ? String(item.Id).slice(-8) : '<none>') +
                            ' series=' + (item && item.SeriesId ? String(item.SeriesId).slice(-8) : '<none>'));
                        var rewritten = rewriteSeriesChildrenUrl(match.url, {
                            userId: match.userId,
                            parentId: match.parentId,
                            item: item
                        });
                        if (!rewritten) {
                            debug('parent is not Series/Season; fallback original request');
                            return nativeFetch(request);
                        }
                        debug('child route ' + debugUrl(rewritten) + ' UserId=uppercase');
                        return nativeFetch(rewritten.toString(), {
                            method: 'GET',
                            headers: request.headers,
                            credentials: request.credentials,
                            signal: request.signal
                        }).then(function (childResponse) {
                            debug('child status=' + childResponse.status);
                            return childResponse.clone().json().then(function (payload) {
                                var items = payload && Array.isArray(payload.Items) ? payload.Items.length : '<not-array>';
                                debug('child Items=' + items + ' total=' +
                                    (payload && payload.TotalRecordCount != null ? payload.TotalRecordCount : '<none>'));
                                if (items === 0 && /\/Seasons$/.test(rewritten.pathname)) {
                                    var episodeFallback = new URL(rewritten.toString());
                                    episodeFallback.pathname = episodeFallback.pathname.replace(/\/Seasons$/, '/Episodes');
                                    debug('seasons empty; fallback ' + debugUrl(episodeFallback));
                                    return nativeFetch(episodeFallback.toString(), {
                                        method: 'GET',
                                        headers: request.headers,
                                        credentials: request.credentials,
                                        signal: request.signal
                                    }).then(function (fallbackResponse) {
                                        debug('episode fallback status=' + fallbackResponse.status);
                                        return fallbackResponse.clone().json().then(function (fallbackPayload) {
                                            debug('episode fallback Items=' +
                                                (fallbackPayload && Array.isArray(fallbackPayload.Items) ? fallbackPayload.Items.length : '<not-array>') +
                                                ' total=' +
                                                (fallbackPayload && fallbackPayload.TotalRecordCount != null ? fallbackPayload.TotalRecordCount : '<none>'));
                                            return fallbackResponse;
                                        }).catch(function () {
                                            debug('episode fallback response was not JSON');
                                            return fallbackResponse;
                                        });
                                    });
                                }
                                return childResponse;
                            }).catch(function () {
                                debug('child response was not JSON');
                                return childResponse;
                            });
                        });
                    });
                }).catch(function (error) {
                    debug('compat exception=' + (error && error.message || String(error)) + '; fallback original request');
                    return nativeFetch(request);
                });
            };

            // Keep the cache payload raw and normalize exactly once after the
            // cache/network decision. Normalizing both inside and outside the
            // cache layer makes every detail/episode fallback request run twice.
            return fetchWithMetadataCache(request, networkFetch).then(function (response) {
                // Cached detail responses may predate this compatibility layer.
                // Normalize those too, so an old zero-count entry cannot keep a
                // series page empty forever.
                return normalizeMetadataResponse(request, response, nativeFetch);
            });
        };
        compatibleFetch.__jelliumSeriesCompatInstalled = true;
        window.fetch = compatibleFetch;
        debug('fetch compatibility installed');
        return true;
    }

    // Some Jellyfin Web list routes still ask for Series children through
    // /Users/{userId}/Items?ParentId=...&IncludeItemTypes=Series. That is
    // correct for a TV library folder, but wrong when ParentId is itself a
    // Series or Season. jellyfin-rs exposes those children through the
    // standard /Shows/{id}/Seasons and /Shows/{id}/Episodes endpoints.
    function install() {
        installSettingsUi();
        installFetchCompatibility();
        var ApiClient = window.ApiClient;
        var prototype = ApiClient && ApiClient.prototype;

        if (!prototype || typeof prototype.getItems !== 'function') {
            return false;
        }
        if (prototype.__jelliumSeriesCompatInstalled) {
            return true;
        }
        if (
            typeof prototype.getItem !== 'function' ||
            typeof prototype.getSeasons !== 'function' ||
            typeof prototype.getEpisodes !== 'function'
        ) {
            return false;
        }

        var getItems = prototype.getItems;
        var getItem = prototype.getItem;
        var getEpisodes = prototype.getEpisodes;

        prototype.getItem = function (userId, itemId) {
            var client = this;
            return getItem.apply(this, arguments).then(function (item) {
                rememberApiItem(item);
                debug('ApiClient getItem type=' + (item && item.Type || '<none>') +
                    ' overview=' + (hasOverview(item) ? 'yes' : 'no') +
                    ' id=' + String(itemId || '').slice(-8));
                return normalizeApiItem(client, userId, item, getItem, getEpisodes).then(function (normalized) {
                    rememberApiItem(normalized);
                    return normalized;
                });
            });
        };

        prototype.getEpisodes = function (seriesId, query) {
            var client = this;
            var episodeQuery = withEpisodeFields(query);
            var userId = episodeQuery && (episodeQuery.userId || episodeQuery.UserId) ||
                client.getCurrentUserId && client.getCurrentUserId();
            return getEpisodes.call(this, seriesId, episodeQuery).then(function (result) {
                return normalizeApiEpisodeResult(client, userId, result, getItem);
            });
        };

        prototype.getItems = function (userId, query) {
            var itemTypes = query && String(query.IncludeItemTypes || '')
                .split(',')
                .map(function (value) { return value.trim(); });
            if (
                !query ||
                query.ParentId == null ||
                !itemTypes.some(function (value) {
                    return value === 'Series' || value === 'Season' || value === 'Episode' || value === 'Video';
                })
            ) {
                return getItems.apply(this, arguments);
            }

            var client = this;
            var parentId = query.ParentId;

            return client.getItem(userId, parentId).then(function (parent) {
                var childQuery = Object.assign({}, query, { userId: userId });
                var wantsEpisodes = itemTypes.some(function (value) {
                    return value === 'Episode' || value === 'Video';
                });
                if (wantsEpisodes) {
                    childQuery = withEpisodeFields(childQuery);
                }
                delete childQuery.ParentId;
                delete childQuery.IncludeItemTypes;
                delete childQuery.Recursive;

                if (parent && parent.Type === 'Series') {
                    if (wantsEpisodes) {
                        debug('ApiClient series Episode query; using getEpisodes');
                        return client.getEpisodes(parent.Id || parentId, childQuery);
                    }
                    return client.getSeasons(parent.Id || parentId, childQuery).then(function (result) {
                        var data = result && result.data ? result.data : result;
                        if (data && Array.isArray(data.Items) && data.Items.length === 0) {
                            debug('ApiClient seasons empty; fallback getEpisodes');
                            return client.getEpisodes(parent.Id || parentId, childQuery);
                        }
                        return result;
                    });
                }

                if (parent && parent.Type === 'Season' && parent.SeriesId) {
                    childQuery.SeasonId = parent.Id || parentId;
                    return client.getEpisodes(parent.SeriesId, childQuery);
                }

                return getItems.call(client, userId, query);
            }).catch(function () {
                return getItems.call(client, userId, query);
            });
        };

        prototype.__jelliumSeriesCompatInstalled = true;
        installOverviewDomFallback();
        debug('ApiClient compatibility installed');
        return true;
    }

    if (!install()) {
        var attempts = 0;
        var timer = window.setInterval(function () {
            attempts += 1;
            if (install() || attempts >= 100) {
                window.clearInterval(timer);
            }
        }, 50);
    }
})();
