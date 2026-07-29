# Jellium Desktop Windows WebView2 prototype

This branch is a Windows-only experiment that replaces the CEF browser shell with the Windows WebView2 runtime.

The prototype:

- reuses the bundled Jellyfin Web frontend;
- serves that frontend from a local same-origin HTTP endpoint;
- proxies Jellyfin API, artwork, and media requests through the same endpoint;
- keeps the existing jellyfin-rs compatibility patch and Nord theme;
- lets the browser use its native HTML5 media path.

The existing CEF and mpv implementation is unchanged on the main branch. This prototype does not yet include the old native mpv bridge, so playback is intentionally browser-native until that bridge is ported separately.

The server URL is read from JELLIUM_SERVER_URL first, then from APPDATA/jellium-desktop/settings.json under serverUrl. If neither exists, the normal Jellyfin server selection page is shown.

The local proxy uses a stable loopback port and a persistent WebView2 data directory at `%LOCALAPPDATA%/jellium-desktop/webview2`, so the Jellyfin Web client can retain its server selection, login token, and other browser state between launches.

This client does not perform scraping itself. It reads the metadata returned by the configured Jellyfin server; library scanning and metadata refresh must still be completed on the server.

Windows 10 and 11 normally have the WebView2 Evergreen Runtime. If it is missing, install it from:

https://developer.microsoft.com/microsoft-edge/webview2/
