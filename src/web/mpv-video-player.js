(function() {
    function getMediaStreamAudioTracks(mediaSource) {
        return mediaSource.MediaStreams.filter(s => s.Type === 'Audio');
    }

    // Convert Jellyfin global MediaStream.Index to 1-based type-relative index
    function getRelativeIndexByType(mediaStreams, jellyIndex, streamType) {
        let relIndex = 1;
        for (const source of mediaStreams) {
            if (source.Type !== streamType || source.IsExternal) continue;
            if (source.Index === jellyIndex) return relIndex;
            relIndex += 1;
        }
        return null;
    }

    function getStreamByIndex(mediaStreams, index) {
        return mediaStreams.find(s => s.Index === index) || null;
    }

    // STRM-backed embedded text subtitles cannot be read reliably by mpv from
    // the remote MKV after a seek. The server exposes short WebVTT windows;
    // Jellium renders those windows in its WebView overlay, while mpv remains
    // responsible for the actual video and audio.
    function isTextSubtitleStream(stream) {
        const codec = String(stream?.Codec || '').toLowerCase();
        return [
            'ass', 'ssa', 'subrip', 'srt', 'mov_text', 'webvtt', 'vtt',
            'text', 'sami', 'stl', 'microdvd', 'mpl2', 'pjs', 'jacosub',
            'subviewer', 'subviewer1', 'vplayer'
        ].includes(codec);
    }

    function getEmbeddedSubtitleWindowUrl(options, stream, startSeconds) {
        if (!options?.item?.Id || !stream?.Index && stream?.Index !== 0) {
            return null;
        }
        const apiClient = window.ApiClient;
        const serverAddress = apiClient?.serverAddress?.();
        if (!serverAddress) return null;
        const mediaSourceId = options.mediaSource?.Id || options.item.Id;
        const ticks = Math.max(0, Math.floor((Number(startSeconds) || 0) * 10000000));
        const url = new URL(
            `/Videos/${encodeURIComponent(options.item.Id)}/${encodeURIComponent(mediaSourceId)}` +
            `/Subtitles/${encodeURIComponent(stream.Index)}/${ticks}/Stream.vtt`,
            serverAddress,
        );
        const accessToken = apiClient?.accessToken?.();
        if (accessToken) url.searchParams.set('api_key', accessToken);
        return url.toString();
    }

    function parseVttTimestamp(value) {
        const match = String(value || '').trim().match(/^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/);
        if (!match) return null;
        return (Number(match[1] || 0) * 3600) +
            (Number(match[2]) * 60) + Number(match[3]) + Number(match[4]) / 1000;
    }

    function parseVttCues(text) {
        const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
        const cues = [];
        for (let index = 0; index < lines.length; index += 1) {
            const timing = lines[index].match(/^\s*(\S+)\s+-->\s+(\S+)/);
            if (!timing) continue;
            const start = parseVttTimestamp(timing[1]);
            const end = parseVttTimestamp(timing[2]);
            if (start == null || end == null || end <= start) continue;
            const cueLines = [];
            for (index += 1; index < lines.length && lines[index].trim() !== ''; index += 1) {
                cueLines.push(lines[index]);
            }
            const cueText = cueLines.join('\n').trim();
            if (cueText) cues.push({ start, end, text: cueText });
        }
        return cues;
    }

    class mpvVideoPlayer extends window.MpvPlayerBase {
        constructor(args) {
            super(args);
            const { loading, appRouter, globalize, dashboard, playbackManager } = args;
            this.loading = loading;
            this.appRouter = appRouter;
            this.globalize = globalize;
            this.playbackManager = playbackManager;
            if (dashboard && dashboard.default) {
                this.setTransparency = dashboard.default.setBackdropTransparency.bind(dashboard);
            } else {
                this.setTransparency = () => {};
            }

            this.id = 'mpvvideoplayer';
            this.logTag = 'Video';
            this.name = 'MPV Video Player';
            this.syncPlayWrapAs = 'htmlvideoplayer';
            this.priority = -1;
            this.useFullSubtitleUrls = true;
            this.isLocalPlayer = true;
            this.isFetching = false;

            window._mpvVideoPlayerInstance = this;

            this._videoDialog = undefined;
            this._currentSrc = undefined;
            this._timeUpdated = false;
            this._currentPlayOptions = undefined;
            this._endedPending = false;
            this._nativeSubtitleSession = null;
            this._nativeSubtitleOverlay = null;

            // Support jellyfin-web v10.10.7
            this._currentAspectRatio = undefined;

            this.handlers.onPlaying = () => {
                if (!this._started) {
                    this._started = true;
                    this.loading.hide();
                    const dlg = this._videoDialog;
                    // Remove poster so video shows through from subsurface
                    if (dlg) {
                        const poster = dlg.querySelector('.mpvPoster');
                        if (poster) poster.remove();
                    }
                    // "fullscreen" = fills entire web content area, not the actual screen
                    if (this._currentPlayOptions?.fullscreen) {
                        this.appRouter.showVideoOsd();
                        if (dlg) dlg.style.zIndex = 'unset';
                    }
                    window.api.player.setVideoRectangle(0, 0, 0, 0);
                }
                this._emitPlaying();
            };

            this.handlers.onTimeUpdate = (time) => {
                if (time && !this._timeUpdated) this._timeUpdated = true;
                this._seeking = false;
                this._currentTime = time;
                this._updateNativeSubtitleOverlay(time);
                this.events.trigger(this, 'timeupdate');
            };

            this.handlers.onEnded = () => {
                if (!this._endedPending) {
                    this._endedPending = true;
                    this._stopNativeProgressiveSubtitle('ended');
                    this.onEndedInternal();
                }
            };

            this.handlers.onError = (error) => {
                this.removeMediaDialog();
                console.error(`[Media] [${this.logTag}] media error:`, error);
                this.events.trigger(this, 'error', [{ type: 'mediadecodeerror' }]);
            };
        }

        async play(options) {
            console.debug(`[Media] [${this.logTag}] play() called with options:`, options);
            this._started = false;
            this._timeUpdated = false;
            this._currentTime = null;
            this._endedPending = false;
            if (options.resetSubtitleOffset !== false) this.resetSubtitleOffset();
            if (options.fullscreen) this.loading.show();  // fills entire web content area, not the actual screen
            await this.createMediaElement(options);
            console.debug(`[Media] [${this.logTag}] createMediaElement done, calling setCurrentSrc`);
            const result = await this.setCurrentSrc(options);

            // needed when only audio is single external
            const externalAudio = options.mediaSource?.MediaStreams?.find(s => s.Type === 'Audio' && s.IsExternal);
            if (externalAudio && options.playMethod !== 'Transcode') {
                this.setAudioStreamIndex(externalAudio.Index);
            }
            return result;
        }

        get mediaType() { return 'video'; }

        _resolveTracks(options) {
            const streams = options.mediaSource?.MediaStreams || [];
            let defaultAudioIdx = options.mediaSource.DefaultAudioStreamIndex ?? -1;
            const defaultSubIdx = options.mediaSource.DefaultSubtitleStreamIndex ?? -1;

            if (defaultAudioIdx < 0) {
                const fallback = streams.find(s => s.Type === 'Audio' && !s.IsExternal)
                    ?? streams.find(s => s.Type === 'Audio');
                if (fallback) defaultAudioIdx = fallback.Index;
            }

            // Mirror jellyfin-web's UI selection exactly: feed mpv the relative
            // index for DefaultAudioStreamIndex, or TRACK_DISABLE if none is selected.
            // mpv auto track selection is completely disabled as it conflicts with
            // the fact that jellyfin-web is ultimately responsible for that.
            let audioParam = MpvPlayerBase.TRACK_DISABLE;
            let externalAudioUrl = null;
            if (options.playMethod === 'Transcode') {
                // Server bakes the chosen audio into the transcoded output
                // (single audio track in the m3u8). Source MediaStreams indexing
                // doesn't apply — see htmlVideoPlayer/plugin.js:514 for the same
                // logic. Don't audio-add either; audio is already in the stream.
                audioParam = 1;
            } else if (defaultAudioIdx >= 0) {
                const audioStream = getStreamByIndex(streams, defaultAudioIdx);
                if (audioStream && audioStream.DeliveryMethod === 'External' && audioStream.DeliveryUrl) {
                    externalAudioUrl = audioStream.DeliveryUrl;
                } else {
                    const relIdx = getRelativeIndexByType(streams, defaultAudioIdx, 'Audio');
                    audioParam = relIdx != null ? relIdx : MpvPlayerBase.TRACK_DISABLE;
                }
            }

            let subParam = MpvPlayerBase.TRACK_DISABLE;
            let externalSubUrl = null;
            if (defaultSubIdx >= 0) {
                const subStream = getStreamByIndex(streams, defaultSubIdx);
                if (subStream && subStream.DeliveryMethod === 'External' && subStream.DeliveryUrl) {
                    this._stopNativeProgressiveSubtitle('external subtitle');
                    externalSubUrl = subStream.DeliveryUrl;
                } else {
                    if (isTextSubtitleStream(subStream)) {
                        this._startNativeProgressiveSubtitle(subStream);
                    } else {
                        this._stopNativeProgressiveSubtitle('embedded non-text subtitle');
                        const relIdx = getRelativeIndexByType(streams, defaultSubIdx, 'Subtitle');
                        subParam = relIdx != null ? relIdx : MpvPlayerBase.TRACK_DISABLE;
                    }
                }
            } else {
                this._stopNativeProgressiveSubtitle('subtitle disabled');
            }

            // Native overlay subtitles and mpv subtitles are mutually exclusive.
            // Text subtitles are served by the bounded WebVTT window above;
            // non-text subtitles still use mpv's embedded track selection.
            if (defaultSubIdx >= 0) {
                const selected = getStreamByIndex(streams, defaultSubIdx);
                if (selected && isTextSubtitleStream(selected) &&
                        !(selected.DeliveryMethod === 'External' && selected.DeliveryUrl)) {
                    subParam = MpvPlayerBase.TRACK_DISABLE;
                }
            }

            return { videoParam: 1, audioParam, subParam, externalAudioUrl, externalSubUrl };
        }

        _beforeLoad(options) {
            window.api.player.setAspectMode(options?.aspectRatio || this.getAspectRatio());
        }

        setSubtitleStreamIndex(index) {
            if (index == null || index < 0) {
                this._stopNativeProgressiveSubtitle('subtitle disabled');
                window.api.player.setSubtitleStream(MpvPlayerBase.TRACK_DISABLE);
                return;
            }
            const streams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            const stream = getStreamByIndex(streams, index);
            if (stream && stream.DeliveryMethod === 'External' && stream.DeliveryUrl) {
                this._stopNativeProgressiveSubtitle('external subtitle');
                window.api.player.setSubtitleStream(MpvPlayerBase.TRACK_DISABLE);
                window.api.player.addSubtitleStream(stream.DeliveryUrl);
                return;
            }
            if (isTextSubtitleStream(stream)) {
                window.api.player.setSubtitleStream(MpvPlayerBase.TRACK_DISABLE);
                this._startNativeProgressiveSubtitle(stream);
                return;
            }
            this._stopNativeProgressiveSubtitle('embedded non-text subtitle');
            const relIdx = getRelativeIndexByType(streams, index, 'Subtitle');
            window.api.player.setSubtitleStream(relIdx != null ? relIdx : MpvPlayerBase.TRACK_DISABLE);
        }

        _ensureNativeSubtitleOverlay() {
            const dlg = this._videoDialog;
            if (!dlg) return null;
            let overlay = dlg.querySelector('.mpvNativeSubtitleOverlay');
            if (!overlay) {
                overlay = document.createElement('div');
                overlay.className = 'mpvNativeSubtitleOverlay';
                overlay.style.cssText = [
                    'position:absolute', 'left:5%', 'right:5%', 'bottom:9%',
                    'z-index:2147483000', 'display:flex', 'justify-content:center',
                    'pointer-events:none', 'text-align:center', 'white-space:pre-wrap',
                    'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
                    'font-size:clamp(18px,3vw,42px)', 'font-weight:600',
                    'line-height:1.35', 'color:#fff',
                    'text-shadow:0 2px 3px #000,0 -1px 2px #000,2px 0 2px #000,-2px 0 2px #000',
                    'visibility:hidden'
                ].join(';');
                dlg.appendChild(overlay);
            }
            this._nativeSubtitleOverlay = overlay;
            return overlay;
        }

        _clearNativeSubtitleOverlay() {
            const overlay = this._nativeSubtitleOverlay || this._videoDialog?.querySelector('.mpvNativeSubtitleOverlay');
            if (overlay) {
                overlay.textContent = '';
                overlay.style.visibility = 'hidden';
            }
        }

        _stopNativeProgressiveSubtitle(reason) {
            const session = this._nativeSubtitleSession;
            if (!session) {
                this._clearNativeSubtitleOverlay();
                return;
            }
            this._nativeSubtitleSession = null;
            if (session.controller) session.controller.abort();
            this._clearNativeSubtitleOverlay();
            console.debug(`[Media] [${this.logTag}] native subtitles stopped: ${reason || 'switch'}`);
        }

        _startNativeProgressiveSubtitle(stream) {
            this._stopNativeProgressiveSubtitle('switch');
            const options = this._currentPlayOptions;
            if (!options || !stream || !this._ensureNativeSubtitleOverlay()) return;
            const session = {
                stream,
                options,
                cues: [],
                loadedFrom: 0,
                loadedUntil: 0,
                loading: false,
                controller: null,
                requestStart: -1,
                runId: 0
            };
            this._nativeSubtitleSession = session;
            const currentSeconds = Math.max(0, (Number(this._currentTime) || 0) / 1000);
            this._loadNativeSubtitleWindow(session, Math.max(0, currentSeconds - 5), false);
        }

        _loadNativeSubtitleWindow(session, startSeconds, append) {
            if (this._nativeSubtitleSession !== session) return;
            const start = Math.max(0, Number(startSeconds) || 0);
            if (session.loading && append) return;
            if (session.controller) session.controller.abort();
            session.controller = new AbortController();
            session.loading = true;
            session.requestStart = start;
            const runId = ++session.runId;
            if (!append) {
                session.cues = [];
                session.loadedFrom = start;
                session.loadedUntil = start;
                this._clearNativeSubtitleOverlay();
            }
            const url = getEmbeddedSubtitleWindowUrl(session.options, session.stream, start);
            if (!url) {
                session.loading = false;
                return;
            }
            const headers = new Headers({ Accept: 'text/vtt' });
            console.debug(`[Media] [${this.logTag}] subtitle window start=${start.toFixed(3)}s`);
            fetch(url, {
                method: 'GET',
                headers,
                credentials: 'include',
                cache: 'no-store',
                signal: session.controller.signal
            }).then(response => {
                if (!response.ok) throw new Error(`subtitle window status=${response.status}`);
                return response.text();
            }).then(body => {
                if (this._nativeSubtitleSession !== session || session.runId !== runId) return;
                const cues = parseVttCues(body);
                if (!append) session.cues = [];
                for (const cue of cues) {
                    if (!session.cues.some(existing => existing.start === cue.start &&
                            existing.end === cue.end && existing.text === cue.text)) {
                        session.cues.push(cue);
                    }
                }
                session.cues.sort((a, b) => a.start - b.start || a.end - b.end);
                session.loadedFrom = append ? Math.min(session.loadedFrom, start) : start;
                session.loadedUntil = append ? Math.max(session.loadedUntil, start + 30) : start + 30;
                this._updateNativeSubtitleOverlay(this._currentTime);
                console.debug(`[Media] [${this.logTag}] subtitle window ready cues=${cues.length}`);
            }).catch(error => {
                if (error?.name !== 'AbortError' && this._nativeSubtitleSession === session && session.runId === runId) {
                    console.warn(`[Media] [${this.logTag}] subtitle window failed:`, error);
                }
            }).finally(() => {
                if (this._nativeSubtitleSession === session && session.runId === runId) {
                    session.loading = false;
                }
            });
        }

        _updateNativeSubtitleOverlay(timeMs) {
            const session = this._nativeSubtitleSession;
            if (!session) return;
            const current = Math.max(0, (Number(timeMs) || 0) / 1000);
            const rate = Math.max(1, Number(this._playRate) || 1);
            const subtitleTime = current - (Number(this._currentSubtitleOffset) || 0);
            const active = session.cues.filter(cue => subtitleTime >= cue.start && subtitleTime < cue.end);
            const overlay = this._ensureNativeSubtitleOverlay();
            if (overlay) {
                overlay.textContent = active.map(cue => cue.text).join('\n');
                overlay.style.visibility = active.length ? 'visible' : 'hidden';
            }
            if (session.loading) return;
            const outside = current < session.loadedFrom - 2 || current > session.loadedUntil + 2;
            const lead = Math.max(6, Math.min(18, rate * 6));
            if (outside) {
                this._loadNativeSubtitleWindow(session, Math.max(0, current - 5), false);
            } else if (current >= session.loadedUntil - lead) {
                this._loadNativeSubtitleWindow(session, Math.max(0, session.loadedUntil - 1), true);
            }
        }

        setSecondarySubtitleStreamIndex(index) {}

        resetSubtitleOffset() {
            this._currentSubtitleOffset = 0;
            this._showSubtitleOffset = false;
            window.api.player.setSubtitleDelay(0);
        }

        enableShowingSubtitleOffset() { this._showSubtitleOffset = true; }
        disableShowingSubtitleOffset() { this._showSubtitleOffset = false; }
        isShowingSubtitleOffsetEnabled() { return this._showSubtitleOffset === true; }
        setSubtitleOffset(offset) {
            const v = parseFloat(offset) || 0;
            this._currentSubtitleOffset = v;
            window.api.player.setSubtitleDelay(Math.round(v * 1000));
        }
        getSubtitleOffset() { return this._currentSubtitleOffset || 0; }

        setAudioStreamIndex(index) {
            if (index == null || index < 0) {
                window.api.player.setAudioStream(MpvPlayerBase.TRACK_DISABLE);
                return;
            }
            const streams = this._currentPlayOptions?.mediaSource?.MediaStreams || [];
            const stream = getStreamByIndex(streams, index);
            if (stream?.IsExternal) {
                // External audio isn't part of the source container and the server
                // doesn't pre-publish a DeliveryUrl for it, so we can't audio-add
                // client-side. Re-enter playbackManager with canSetAudioStreamIndex
                // forced false so it routes through changeStream — the server then
                // regenerates the playback URL with the external audio attached.
                this._forceServerReload = true;
                try {
                    this.playbackManager.setAudioStreamIndex(index, this);
                } finally {
                    this._forceServerReload = false;
                }
                return;
            }
            const relIdx = getRelativeIndexByType(streams, index, 'Audio');
            window.api.player.setAudioStream(relIdx != null ? relIdx : MpvPlayerBase.TRACK_DISABLE);
        }

        stop(destroyPlayer) {
            this._stopNativeProgressiveSubtitle('stop');
            if (!destroyPlayer && this._videoDialog && this._currentPlayOptions?.backdropUrl) {
                const dlg = this._videoDialog;
                const url = this._currentPlayOptions.backdropUrl;
                if (!dlg.querySelector('.mpvPoster')) {
                    const poster = document.createElement('div');
                    poster.classList.add('mpvPoster');
                    poster.style.cssText = `position:absolute;top:0;left:0;right:0;bottom:0;background:#000 url('${url}') center/cover no-repeat;`;
                    dlg.appendChild(poster);
                }
            }
            window.api.player.stop();
            this.handlers.onEnded();
            if (destroyPlayer) this.destroy();
            return Promise.resolve();
        }

        removeMediaDialog() {
            this._stopNativeProgressiveSubtitle('dialog removed');
            window.api.player.stop();
            if (window.jmpNative) window.jmpNative.playerOsdActive(false);
            window.api.player.setVideoRectangle(-1, 0, 0, 0);
            document.body.classList.remove('hide-scroll');
            const dlg = this._videoDialog;
            if (dlg) {
                this.setTransparency(0);
                this._videoDialog = null;
                dlg.parentNode.removeChild(dlg);
            }
        }

        destroy() {
            this.removeMediaDialog();
            this.disconnectSignals();

            // Support jellyfin-web v10.10.7
            this._currentAspectRatio = undefined;
        }

        createMediaElement(options) {
            let dlg = document.querySelector('.videoPlayerContainer');
            const isNewDlg = !dlg;
            if (isNewDlg) {
                if (window.jmpNative) window.jmpNative.playerOsdActive(true);
                dlg = document.createElement('div');
                dlg.classList.add('videoPlayerContainer');
                dlg.style.cssText = 'position:fixed;top:0;bottom:0;left:0;right:0;display:flex;align-items:center;background:transparent;';
                if (options.fullscreen) dlg.style.zIndex = 1000;  // fills entire web content area, not the actual screen
                document.body.insertBefore(dlg, document.body.firstChild);
                this._videoDialog = dlg;

                this.connectSignals();
                if (window.jmpNative) {
                    window.jmpNative.notifyRateChange(this._playRate);
                }
            } else {
                this._videoDialog = dlg;
            }

            const existing = dlg.querySelector('.mpvPoster');
            if (existing) existing.remove();
            const poster = document.createElement('div');
            poster.classList.add('mpvPoster');
            const bg = options.backdropUrl
                ? `#000 url('${options.backdropUrl}') center/cover no-repeat`
                : '#000';
            poster.style.cssText = `position:absolute;top:0;left:0;right:0;bottom:0;background:${bg};`;

            const ready = new Promise((resolve) => {
                if (isNewDlg && options.fullscreen) {
                    dlg.style.animation = 'mpv-video-zoomin 240ms ease-in normal';
                    dlg.addEventListener('animationend', resolve, { once: true });
                } else {
                    resolve();
                }
            });
            if (isNewDlg) ready.then(() => this.setTransparency(2));
            dlg.appendChild(poster);

            if (options.fullscreen) document.body.classList.add('hide-scroll');  // fills entire web content area, not the actual screen
            return ready;
        }

        canPlayMediaType(mediaType) {
            return (mediaType || '').toLowerCase() === 'video';
        }
        canPlayItem(item) { return this.canPlayMediaType(item.MediaType); }
        supportsPlayMethod() { return true; }
        static getSupportedFeatures() { return ['PlaybackRate', 'SetAspectRatio']; }
        supports(feature) { return mpvVideoPlayer.getSupportedFeatures().includes(feature); }
        isFullscreen() { return window._isFullscreen === true; }
        toggleFullscreen() {
            if (window.jmpNative) window.jmpNative.toggleFullscreen();
        }

        setPlaybackRate(value) {
            super.setPlaybackRate(value);
            if (window.jmpNative) window.jmpNative.notifyRateChange(value);
        }

        canSetAudioStreamIndex() { return !this._forceServerReload; }
        setPictureInPictureEnabled() {}
        isPictureInPictureEnabled() { return false; }
        isAirPlayEnabled() { return false; }
        setAirPlayEnabled() {}
        setBrightness() {}
        getBrightness() { return 100; }

        togglePictureInPicture() {}
        toggleAirPlay() {}
        getStats() { return Promise.resolve({ categories: [] }); }
        getSupportedAspectRatios() {
            return [
                { id: 'auto',  name: this.globalize.translate('Auto') },
                { id: 'cover', name: this.globalize.translate('AspectRatioCover') },
                { id: 'fill',  name: this.globalize.translate('AspectRatioFill') }
            ];
        }
        getAspectRatio() {
            const aspectRatio = typeof this.appSettings.aspectRatio === 'function'
                ? this.appSettings.aspectRatio()
                // Support jellyfin-web v10.10.7
                : this._currentAspectRatio;

            return aspectRatio || 'auto';
        }
        setAspectRatio(value) {
            if (typeof this.appSettings.aspectRatio === 'function') {
                this.appSettings.aspectRatio(value);
            } else {
                // Support jellyfin-web v10.10.7
                this._currentAspectRatio = value;
            }
            window.api.player.setAspectMode(value);
        }
    }

    window._mpvVideoPlayer = mpvVideoPlayer;
    console.debug('[Media] mpvVideoPlayer class installed');
})();
