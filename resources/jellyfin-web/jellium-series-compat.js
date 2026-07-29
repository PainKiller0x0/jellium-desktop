(function () {
    'use strict';

    // Some Jellyfin Web list routes still ask for Series children through
    // /Users/{userId}/Items?ParentId=...&IncludeItemTypes=Series. That is
    // correct for a TV library folder, but wrong when ParentId is itself a
    // Series or Season. jellyfin-rs exposes those children through the
    // standard /Shows/{id}/Seasons and /Shows/{id}/Episodes endpoints.
    function install() {
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
                    return client.getSeasons(parent.Id || parentId, childQuery);
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
