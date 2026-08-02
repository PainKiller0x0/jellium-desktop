#![windows_subsystem = "windows"]

use std::env;
use std::fs;
use std::io::Cursor;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use ico::IconDir;
use percent_encoding::percent_decode_str;
use serde_json::Value;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::{Icon, WindowBuilder};
use tiny_http::{
    Header, Method as TinyMethod, Request as TinyRequest, Response as TinyResponse, Server,
    StatusCode as TinyStatusCode,
};
use ureq::Agent;
use wry::{WebContext, WebViewBuilder};

const NORD_CSS_PATH: &str = "jellium-nord.css";
const LOCAL_PROXY_PORT: u16 = 39782;
// Bump whenever the bundled compatibility layer changes. WebView2 keeps a
// persistent HTTP cache between launches, so reusing this query value can
// silently load an older script even when the executable contains new code.
const FRONTEND_CACHE_BUSTER: &str = "series-compat-12";
const PROXY_QUEUE_CAPACITY: usize = 64;

struct ProxyState {
    root: PathBuf,
    upstream: String,
    local_url: String,
    metadata_cache_root: PathBuf,
    agent: Agent,
}

enum MetadataCacheRoute {
    Get(String),
    Put,
    Clear,
    Count,
}

fn main() -> wry::Result<()> {
    let root = web_root();
    assert!(
        root.is_dir(),
        "Jellyfin Web assets not found: {}",
        root.display()
    );

    let upstream = saved_server_url();
    let server = Server::http(format!("127.0.0.1:{LOCAL_PROXY_PORT}"))
        .expect("create local Jellyfin proxy on the stable port");
    let local_url = format!("http://127.0.0.1:{LOCAL_PROXY_PORT}");
    let metadata_cache_root = metadata_cache_dir();

    let state = Arc::new(ProxyState {
        root,
        upstream,
        local_url: local_url.clone(),
        metadata_cache_root,
        agent: ureq::agent(),
    });
    let server_state = state.clone();
    thread::Builder::new()
        .name("jellium-local-proxy".into())
        .spawn(move || {
            let (request_tx, request_rx) = mpsc::sync_channel(PROXY_QUEUE_CAPACITY);
            let request_rx = Arc::new(Mutex::new(request_rx));
            for worker_id in 0..proxy_worker_count() {
                let state = server_state.clone();
                let request_rx = Arc::clone(&request_rx);
                let _ = thread::Builder::new()
                    .name(format!("jellium-proxy-worker-{worker_id}"))
                    .spawn(move || {
                        loop {
                            let request = match request_rx.lock() {
                                Ok(receiver) => receiver.recv(),
                                Err(_) => return,
                            };
                            let Ok(request) = request else {
                                return;
                            };
                            serve_request(request, &state);
                        }
                    });
            }
            for request in server.incoming_requests() {
                if request_tx.send(request).is_err() {
                    return;
                }
            }
        })
        .expect("start local proxy thread");

    let event_loop = EventLoopBuilder::new().build();
    let window = WindowBuilder::new()
        .with_title("Jellium Desktop (WebView2)")
        .with_window_icon(app_icon())
        .build(&event_loop)
        .expect("create WebView2 window");
    let start_url = format!("{local_url}/index.html?jellium={FRONTEND_CACHE_BUSTER}");
    let mut web_context = WebContext::new(Some(webview_data_dir()));
    let webview = WebViewBuilder::new_with_web_context(&mut web_context)
        .with_devtools(true)
        .with_autoplay(true)
        .with_clipboard(true)
        .with_url(&start_url)
        .build(&window)?;
    let mut webview = Some(webview);

    event_loop.run(move |event, _event_loop, control_flow| {
        *control_flow = ControlFlow::Wait;
        let _keep_context_alive = &web_context;
        if let Event::WindowEvent { event, .. } = event {
            if let WindowEvent::CloseRequested = event {
                window.set_visible(false);
                drop(webview.take());
                *control_flow = ControlFlow::Exit;
            }
        }
    });
}

fn proxy_worker_count() -> usize {
    thread::available_parallelism()
        .map(|parallelism| parallelism.get().clamp(4, 12))
        .unwrap_or(8)
}

fn webview_data_dir() -> PathBuf {
    let path = app_data_dir().join("webview2");
    let _ = fs::create_dir_all(&path);
    path
}

fn app_data_dir() -> PathBuf {
    env::var_os("LOCALAPPDATA")
        .or_else(|| env::var_os("APPDATA"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("jellium-desktop")
}

fn metadata_cache_dir() -> PathBuf {
    let path = app_data_dir().join("jellium-cache");
    let _ = fs::create_dir_all(&path);
    path
}

fn app_icon() -> Option<Icon> {
    let bytes = include_bytes!("../../resources/win/jellyfin.ico");
    let icon_dir = IconDir::read(Cursor::new(bytes)).ok()?;
    let entry = icon_dir
        .entries()
        .iter()
        .max_by_key(|entry| (entry.width() as u64) * (entry.height() as u64))?;
    let image = entry.decode().ok()?;
    Icon::from_rgba(image.rgba_data().to_vec(), image.width(), image.height()).ok()
}

fn web_root() -> PathBuf {
    if let Ok(path) = env::var("JELLIUM_WEB_DIR") {
        let path = PathBuf::from(path);
        if path.is_dir() {
            return path;
        }
    }

    if let Ok(exe) = env::current_exe()
        && let Some(parent) = exe.parent()
    {
        let path = parent.join("jellyfin-web");
        if path.is_dir() {
            return path;
        }
    }

    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("resources")
        .join("jellyfin-web")
}

fn saved_server_url() -> String {
    if let Ok(url) = env::var("JELLIUM_SERVER_URL")
        && !url.trim().is_empty()
    {
        return normalize_url(&url);
    }

    let Some(app_data) = env::var_os("APPDATA") else {
        return String::new();
    };
    let path = PathBuf::from(app_data)
        .join("jellium-desktop")
        .join("settings.json");
    let Ok(bytes) = fs::read(path) else {
        return String::new();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return String::new();
    };
    value
        .get("serverUrl")
        .and_then(Value::as_str)
        .map(normalize_url)
        .unwrap_or_default()
}

fn normalize_url(value: &str) -> String {
    value.trim().trim_end_matches('/').to_string()
}

fn serve_request(request: TinyRequest, state: &ProxyState) {
    if request.method() == &TinyMethod::Options {
        respond_bytes(request, 204, "text/plain; charset=utf-8", Vec::new());
        return;
    }

    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("/");
    if let Some(route) = metadata_cache_route(request.method(), &url) {
        serve_metadata_cache(request, &state.metadata_cache_root, route);
        return;
    }
    if let Some(relative) = safe_relative_path(path) {
        let candidate = state.root.join(&relative);
        if candidate.is_file() {
            serve_static(request, state, &relative, &candidate);
            return;
        }
    }

    if state.upstream.is_empty() {
        respond_bytes(
            request,
            503,
            "text/plain; charset=utf-8",
            b"Jellyfin server URL is not configured".to_vec(),
        );
        return;
    }
    proxy_request(request, state, &url);
}

fn metadata_cache_route(method: &TinyMethod, url: &str) -> Option<MetadataCacheRoute> {
    let (path, query) = url.split_once('?').unwrap_or((url, ""));
    if path != "/__jellium/metadata-cache" {
        return None;
    }

    let action = query_param(query, "action")?;
    match (method, action.as_str()) {
        (&TinyMethod::Get, "get") => Some(MetadataCacheRoute::Get(query_param(query, "key")?)),
        (&TinyMethod::Get, "count") => Some(MetadataCacheRoute::Count),
        (&TinyMethod::Post, "put") => Some(MetadataCacheRoute::Put),
        (&TinyMethod::Delete, "clear") => Some(MetadataCacheRoute::Clear),
        _ => None,
    }
}

fn serve_metadata_cache(mut request: TinyRequest, root: &Path, route: MetadataCacheRoute) {
    match route {
        MetadataCacheRoute::Get(key) => {
            let path = metadata_cache_file(root, &key);
            let Ok(bytes) = fs::read(path) else {
                respond_bytes(
                    request,
                    404,
                    "application/json; charset=utf-8",
                    b"{}".to_vec(),
                );
                return;
            };
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                respond_bytes(
                    request,
                    404,
                    "application/json; charset=utf-8",
                    b"{}".to_vec(),
                );
                return;
            };
            if value.get("key").and_then(Value::as_str) != Some(key.as_str()) {
                respond_bytes(
                    request,
                    404,
                    "application/json; charset=utf-8",
                    b"{}".to_vec(),
                );
                return;
            }
            respond_bytes(request, 200, "application/json; charset=utf-8", bytes);
        }
        MetadataCacheRoute::Put => {
            let mut body = Vec::new();
            if request.as_reader().read_to_end(&mut body).is_err() || body.len() > 8 * 1024 * 1024 {
                respond_bytes(
                    request,
                    400,
                    "application/json; charset=utf-8",
                    b"{}".to_vec(),
                );
                return;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&body) else {
                respond_bytes(
                    request,
                    400,
                    "application/json; charset=utf-8",
                    b"{}".to_vec(),
                );
                return;
            };
            let Some(key) = value.get("key").and_then(Value::as_str) else {
                respond_bytes(
                    request,
                    400,
                    "application/json; charset=utf-8",
                    b"{}".to_vec(),
                );
                return;
            };
            if value.get("body").and_then(Value::as_str).is_none() {
                respond_bytes(
                    request,
                    400,
                    "application/json; charset=utf-8",
                    b"{}".to_vec(),
                );
                return;
            }
            let _ = fs::create_dir_all(root);
            let path = metadata_cache_file(root, key);
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_nanos())
                .unwrap_or_default();
            let temporary = root.join(format!(".{:016x}.{}.tmp", metadata_cache_hash(key), stamp));
            let persisted = fs::write(&temporary, &body).is_ok()
                && (fs::rename(&temporary, &path).is_ok()
                    || (fs::remove_file(&path).is_ok() && fs::rename(&temporary, &path).is_ok()));
            if !persisted {
                let _ = fs::remove_file(&temporary);
                respond_bytes(
                    request,
                    500,
                    "application/json; charset=utf-8",
                    b"{}".to_vec(),
                );
                return;
            }
            respond_bytes(request, 204, "application/json; charset=utf-8", Vec::new());
        }
        MetadataCacheRoute::Clear => {
            if let Ok(entries) = fs::read_dir(root) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                        let _ = fs::remove_file(path);
                    }
                }
            }
            respond_bytes(request, 204, "application/json; charset=utf-8", Vec::new());
        }
        MetadataCacheRoute::Count => {
            let count = fs::read_dir(root)
                .map(|entries| {
                    entries
                        .flatten()
                        .filter(|entry| {
                            entry.path().extension().and_then(|ext| ext.to_str()) == Some("json")
                        })
                        .count()
                })
                .unwrap_or(0);
            let body = format!(r#"{{"count":{count}}}"#).into_bytes();
            respond_bytes(request, 200, "application/json; charset=utf-8", body);
        }
    }
}

fn metadata_cache_hash(key: &str) -> u64 {
    let mut hash = 14_695_981_039_346_656_037u64;
    for byte in key.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(1_099_511_628_211);
    }
    hash
}

fn metadata_cache_file(root: &Path, key: &str) -> PathBuf {
    root.join(format!("{:016x}.json", metadata_cache_hash(key)))
}

fn serve_static(request: TinyRequest, state: &ProxyState, relative: &str, path: &Path) {
    let mut bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => {
            respond_bytes(
                request,
                500,
                "text/plain; charset=utf-8",
                b"read failed".to_vec(),
            );
            return;
        }
    };

    if relative.eq_ignore_ascii_case("config.json") {
        bytes = patch_config(bytes, &state.local_url);
    } else if relative.eq_ignore_ascii_case("index.html") {
        bytes = patch_index(bytes);
    } else if relative == "node_modules.@jellyfin.sdk.bundle.js" {
        bytes = patch_min_version(bytes);
    }

    let cache_control = if relative.eq_ignore_ascii_case("index.html")
        || relative.eq_ignore_ascii_case("config.json")
    {
        "no-cache"
    } else {
        // All bundled assets are versioned by Jellyfin's filename/query hash;
        // keeping them in WebView2's HTTP cache makes later cold starts local.
        "public, max-age=31536000, immutable"
    };
    if request.method() == &TinyMethod::Head {
        respond_static(request, 200, mime_for(path), cache_control, Vec::new());
    } else {
        respond_static(request, 200, mime_for(path), cache_control, bytes);
    }
}

fn proxy_request(mut request: TinyRequest, state: &ProxyState, url: &str) {
    let method = request.method().to_string();
    let rewritten_url = if request.method() == &TinyMethod::Get
        && !has_request_header(request.headers(), "X-Jellium-Series-Compat")
    {
        rewrite_series_children_request(&state.agent, &state.upstream, url, request.headers())
            .unwrap_or_else(|| url.to_string())
    } else {
        url.to_string()
    };
    let upstream_url = format!("{}{}", state.upstream, rewritten_url);
    let mut body = Vec::new();
    if request.body_length().unwrap_or(0) > 0 {
        if request.as_reader().read_to_end(&mut body).is_err() {
            respond_bytes(
                request,
                400,
                "text/plain; charset=utf-8",
                b"bad request body".to_vec(),
            );
            return;
        }
    }

    let mut builder = ureq::http::Request::builder()
        .method(method.as_str())
        .uri(upstream_url);
    for header in request.headers() {
        let name: &str = header.field.as_str().into();
        if should_forward_request_header(name) {
            builder = builder.header(name, header.value.as_str());
        }
    }

    let upstream_request = match builder.body(body) {
        Ok(request) => request,
        Err(error) => {
            respond_bytes(
                request,
                502,
                "text/plain; charset=utf-8",
                format!("proxy request build failed: {error}").into_bytes(),
            );
            return;
        }
    };

    match state.agent.run(upstream_request) {
        Ok(upstream_response) => {
            let status = upstream_response.status().as_u16();
            let headers = upstream_response.headers().clone();
            let reader = upstream_response.into_body().into_reader();
            let mut response =
                TinyResponse::new(TinyStatusCode(status), Vec::new(), reader, None, None);
            for (name, value) in &headers {
                if should_forward_response_header(name.as_str())
                    && let Ok(header) =
                        Header::from_bytes(name.as_str().as_bytes(), value.as_bytes())
                {
                    response = response.with_header(header);
                }
            }
            response = response.with_header(cors_header("Access-Control-Allow-Origin", "*"));
            let _ = request.respond(response);
        }
        Err(error) => {
            respond_bytes(
                request,
                502,
                "text/plain; charset=utf-8",
                format!("upstream request failed: {error}").into_bytes(),
            );
        }
    }
}

fn safe_relative_path(path: &str) -> Option<String> {
    let raw = path.trim_start_matches('/');
    let decoded = percent_decode_str(raw).decode_utf8().ok()?;
    let relative = if decoded.is_empty() {
        "index.html"
    } else {
        decoded.as_ref()
    };
    if Path::new(relative).components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return None;
    }
    Some(relative.to_string())
}

fn patch_config(mut bytes: Vec<u8>, local_url: &str) -> Vec<u8> {
    let Ok(mut value) = serde_json::from_slice::<Value>(&bytes) else {
        return bytes;
    };
    value["servers"] = serde_json::json!([local_url]);
    value["multiserver"] = Value::Bool(false);
    serde_json::to_vec(&value).unwrap_or_else(|_| std::mem::take(&mut bytes))
}

fn patch_min_version(mut bytes: Vec<u8>) -> Vec<u8> {
    let from = b"10.10.0";
    let to = b"4.8.0.0";
    if let Some(start) = bytes.windows(from.len()).position(|window| window == from) {
        bytes[start..start + to.len()].copy_from_slice(to);
    }
    bytes
}

fn patch_index(mut bytes: Vec<u8>) -> Vec<u8> {
    let marker = b"</head>";
    let Some(position) = bytes
        .windows(marker.len())
        .position(|window| window == marker)
    else {
        return bytes;
    };
    let injected = format!(
        r#"<script defer="defer" src="jellium-series-compat.js?v={FRONTEND_CACHE_BUSTER}"></script><link rel="preload" as="style" href="{NORD_CSS_PATH}?v={FRONTEND_CACHE_BUSTER}" onload="this.onload=null;this.rel='stylesheet'"><noscript><link rel="stylesheet" href="{NORD_CSS_PATH}?v={FRONTEND_CACHE_BUSTER}"></noscript>"#
    );
    bytes.splice(position..position, injected.into_bytes());
    bytes
}

fn rewrite_series_children_request(
    agent: &Agent,
    upstream: &str,
    url: &str,
    headers: &[Header],
) -> Option<String> {
    let (path, query) = url.split_once('?')?;
    let segments: Vec<&str> = path
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    if segments.len() != 3 || segments[0] != "Users" || segments[2] != "Items" {
        return None;
    }
    if query_param(query, "IncludeItemTypes")?.as_str() != "Series" {
        return None;
    }
    let parent_id = query_param(query, "ParentId")?;
    let item_url = format!("{}/Users/{}/Items/{}", upstream, segments[1], parent_id);
    let parent = get_json_with_headers(agent, &item_url, headers)?;
    let item_type = parent.get("Type")?.as_str()?;

    match item_type {
        "Series" => Some(rewrite_children_url(
            path,
            query,
            segments[1],
            &parent_id,
            "Seasons",
            None,
        )),
        "Season" => Some(rewrite_children_url(
            path,
            query,
            segments[1],
            parent.get("SeriesId")?.as_str()?,
            "Episodes",
            Some(&parent_id),
        )),
        _ => None,
    }
}

fn rewrite_children_url(
    _original_path: &str,
    query: &str,
    user_id: &str,
    parent_id: &str,
    child_kind: &str,
    season_id: Option<&str>,
) -> String {
    let mut params = Vec::new();
    for pair in query.split('&').filter(|pair| !pair.is_empty()) {
        let key = pair.split('=').next().unwrap_or_default();
        let decoded_key = percent_decode_str(key).decode_utf8_lossy();
        if matches!(
            decoded_key.as_ref(),
            "ParentId" | "IncludeItemTypes" | "Recursive" | "SortBy" | "SortOrder"
        ) {
            continue;
        }
        params.push(pair.to_string());
    }
    params.retain(|pair| {
        let key = pair.split('=').next().unwrap_or_default();
        let decoded_key = percent_decode_str(key).decode_utf8_lossy();
        decoded_key != "userId" && decoded_key != "UserId"
    });
    params.push(format!("UserId={user_id}"));
    if let Some(season_id) = season_id {
        params.push(format!("SeasonId={season_id}"));
    }
    format!("/Shows/{parent_id}/{child_kind}?{}", params.join("&"))
}

fn query_param(query: &str, wanted: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        let key = percent_decode_str(key).decode_utf8().ok()?;
        if key != wanted {
            return None;
        }
        Some(percent_decode_str(value).decode_utf8().ok()?.into_owned())
    })
}

fn has_request_header(headers: &[Header], wanted: &str) -> bool {
    headers.iter().any(|header| {
        let name: &str = header.field.as_str().into();
        name.eq_ignore_ascii_case(wanted)
    })
}

fn get_json_with_headers(agent: &Agent, url: &str, headers: &[Header]) -> Option<Value> {
    let mut builder = ureq::http::Request::builder().method("GET").uri(url);
    for header in headers {
        let name: &str = header.field.as_str().into();
        if should_forward_request_header(name) {
            builder = builder.header(name, header.value.as_str());
        }
    }
    let request = builder.body(Vec::new()).ok()?;
    let response = agent.run(request).ok()?;
    if response.status().as_u16() != 200 {
        return None;
    }
    let mut body = String::new();
    response
        .into_body()
        .into_reader()
        .read_to_string(&mut body)
        .ok()?;
    serde_json::from_str(&body).ok()
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "application/javascript",
        "css" => "text/css",
        "json" | "map" | "webmanifest" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn should_forward_request_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept"
            | "accept-encoding"
            | "authorization"
            | "content-type"
            | "if-modified-since"
            | "if-none-match"
            | "range"
            | "x-emby-authorization"
            | "x-emby-token"
            | "x-media-browser"
    )
}

fn should_forward_response_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "accept-ranges"
            | "cache-control"
            | "content-range"
            | "content-type"
            | "etag"
            | "last-modified"
            | "location"
            | "set-cookie"
    )
}

fn cors_header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid local proxy header")
}

fn respond_bytes(request: TinyRequest, status: u16, mime: &str, bytes: Vec<u8>) {
    let response = TinyResponse::from_data(bytes)
        .with_status_code(TinyStatusCode(status))
        .with_header(cors_header("Content-Type", mime))
        .with_header(cors_header("Access-Control-Allow-Origin", "*"))
        .with_header(cors_header(
            "Access-Control-Allow-Methods",
            "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        ))
        .with_header(cors_header("Access-Control-Allow-Headers", "*"));
    let _ = request.respond(response);
}

fn respond_static(
    request: TinyRequest,
    status: u16,
    mime: &str,
    cache_control: &str,
    bytes: Vec<u8>,
) {
    let response = TinyResponse::from_data(bytes)
        .with_status_code(TinyStatusCode(status))
        .with_header(cors_header("Content-Type", mime))
        .with_header(cors_header("Cache-Control", cache_control))
        .with_header(cors_header("Access-Control-Allow-Origin", "*"));
    let _ = request.respond(response);
}

#[cfg(test)]
mod tests {
    use super::{
        PROXY_QUEUE_CAPACITY, has_request_header, metadata_cache_route, patch_config,
        proxy_worker_count, rewrite_children_url, safe_relative_path,
    };
    use tiny_http::Header;

    #[test]
    fn config_points_the_web_client_at_the_same_origin_proxy() {
        let patched = patch_config(
            br#"{"servers":[],"multiserver":true}"#.to_vec(),
            "http://127.0.0.1:12345",
        );
        let value: serde_json::Value = serde_json::from_slice(&patched).unwrap();
        assert_eq!(value["servers"][0], "http://127.0.0.1:12345");
        assert_eq!(value["multiserver"], false);
    }

    #[test]
    fn index_injects_series_compatibility_layer() {
        let patched = super::patch_index(br#"<html><head></head></html>"#.to_vec());
        let text = String::from_utf8(patched).unwrap();
        assert!(text.contains("jellium-series-compat.js"));
        assert!(text.contains("series-compat-12"));
        assert!(text.contains("jellium-nord.css?v=series-compat-12"));
        assert!(!text.contains("theme-park.dev"));
        assert!(text.contains("rel=\"preload\" as=\"style\""));
    }

    #[test]
    fn metadata_cache_routes_are_handled_by_the_local_proxy() {
        assert!(metadata_cache_route(
            &super::TinyMethod::Get,
            "/__jellium/metadata-cache?action=get&key=v6%3Ahttps%3A%2F%2Fexample.test%2FItems%2F1"
        )
        .is_some());
        assert!(
            metadata_cache_route(
                &super::TinyMethod::Post,
                "/__jellium/metadata-cache?action=put"
            )
            .is_some()
        );
        assert!(
            metadata_cache_route(
                &super::TinyMethod::Delete,
                "/__jellium/metadata-cache?action=clear"
            )
            .is_some()
        );
        assert!(
            metadata_cache_route(
                &super::TinyMethod::Get,
                "/__jellium/metadata-cache?action=count"
            )
            .is_some()
        );
    }

    #[test]
    fn series_children_query_maps_to_seasons_endpoint() {
        let rewritten = rewrite_children_url(
            "/Users/user/Items",
            "SortBy=SortName&IncludeItemTypes=Series&Recursive=true&Fields=Name&ParentId=series",
            "user",
            "series",
            "Seasons",
            None,
        );
        assert_eq!(rewritten, "/Shows/series/Seasons?Fields=Name&UserId=user");
    }

    #[test]
    fn season_children_query_maps_to_episodes_endpoint() {
        let rewritten = rewrite_children_url(
            "/Users/user/Items",
            "SortBy=SortName&IncludeItemTypes=Series&Recursive=true&Fields=Name&ParentId=season",
            "user",
            "series",
            "Episodes",
            Some("season"),
        );
        assert_eq!(
            rewritten,
            "/Shows/series/Episodes?Fields=Name&UserId=user&SeasonId=season"
        );
    }

    #[test]
    fn compat_marker_prevents_duplicate_series_rewrite() {
        let header = Header::from_bytes(b"X-Jellium-Series-Compat", b"1").unwrap();
        assert!(has_request_header(&[header], "x-jellium-series-compat"));
    }

    #[test]
    fn proxy_worker_pool_has_a_bounded_concurrency_window() {
        assert!((4..=12).contains(&proxy_worker_count()));
        assert!(PROXY_QUEUE_CAPACITY >= proxy_worker_count());
    }

    #[test]
    fn traversal_paths_are_rejected() {
        assert!(safe_relative_path("/../secret").is_none());
        assert_eq!(
            safe_relative_path("/node_modules.%40jellyfin.sdk.bundle.js"),
            Some("node_modules.@jellyfin.sdk.bundle.js".to_string())
        );
    }
}
