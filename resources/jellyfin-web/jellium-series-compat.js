(function () {
    'use strict';

    var debugLines = [];

    function debugUrl(value) {
        try {
            var url = new URL(value, window.location.href);
            return url.pathname + '?keys=' + Array.from(url.searchParams.keys()).join(',');
        } catch (_) {
            return '<invalid-url>';
        }
    }

    function debug(message) {
        var text = '[jellium-series] ' + message;
        debugLines.push(text);
        if (debugLines.length > 40) {
            debugLines.shift();
        }
        if (window.console && typeof window.console.info === 'function') {
            window.console.info(text);
        }
        try {
            window.__jelliumSeriesCompatLog = debugLines.slice();
            if (!window.localStorage || window.localStorage.getItem('jellium-debug') !== '1') {
                return;
            }
            var panel = document.getElementById('jellium-series-debug');
            if (!panel && document.documentElement) {
                panel = document.createElement('pre');
                panel.id = 'jellium-series-debug';
                panel.style.cssText = [
                    'position:fixed', 'right:8px', 'bottom:8px', 'z-index:2147483647',
                    'width:560px', 'max-height:240px', 'overflow:auto', 'margin:0',
                    'padding:8px', 'border:1px solid #35a7ff', 'border-radius:4px',
                    'background:rgba(8,12,20,.94)', 'color:#9fe7ff',
                    'font:11px/1.35 Consolas,monospace', 'white-space:pre-wrap',
                    'pointer-events:none'
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

    debug('compat script loaded');

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
            segments[2] !== 'Items' ||
            url.searchParams.get('IncludeItemTypes') !== 'Series'
        ) {
            return null;
        }

        var parentId = url.searchParams.get('ParentId');
        if (!parentId) {
            return null;
        }
        return { url: url, userId: segments[1], parentId: parentId };
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
            rewritten.pathname = '/Shows/' + encodeURIComponent(parent.item.Id || parent.parentId) + '/Seasons';
            return rewritten;
        }

        if (parent.item.Type === 'Season' && parent.item.SeriesId) {
            rewritten.pathname = '/Shows/' + encodeURIComponent(parent.item.SeriesId) + '/Episodes';
            rewritten.searchParams.set('SeasonId', parent.item.Id || parent.parentId);
            return rewritten;
        }

        return null;
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

            if (request.method !== 'GET') {
                return nativeFetch(input, init);
            }

            var match = isSeriesChildrenUrl(request.url);
            if (!match) {
                return nativeFetch(input, init);
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

        prototype.getItems = function (userId, query) {
            if (
                !query ||
                query.ParentId == null ||
                String(query.IncludeItemTypes || '') !== 'Series'
            ) {
                return getItems.apply(this, arguments);
            }

            var client = this;
            var parentId = query.ParentId;

            // Resolve the parent first. A CollectionFolder/Folder must retain
            // the original query, so the normal library view is untouched.
            return client.getItem(userId, parentId).then(function (parent) {
                var childQuery = Object.assign({}, query, { userId: userId });
                delete childQuery.ParentId;
                delete childQuery.IncludeItemTypes;
                delete childQuery.Recursive;

                if (parent && parent.Type === 'Series') {
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
                // Preserve the original behavior if the compatibility lookup
                // is unavailable or the server rejects the item lookup.
                return getItems.call(client, userId, query);
            });
        };

        prototype.__jelliumSeriesCompatInstalled = true;
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
