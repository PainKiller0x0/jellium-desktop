#![windows_subsystem = "windows"]

use std::env;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::thread;

use percent_encoding::percent_decode_str;
use serde_json::Value;
use tao::event::{Event, WindowEvent};
use tao::event_loop::{ControlFlow, EventLoopBuilder};
use tao::window::WindowBuilder;
use tiny_http::{
    Header, Method as TinyMethod, Request as TinyRequest, Response as TinyResponse,
    Server, StatusCode as TinyStatusCode,
};
use ureq::Agent;
use wry::WebViewBuilder;

const NORD_CSS_URL: &str = "https://theme-park.dev/css/base/jellyfin/nord.css";

struct ProxyState {
    root: PathBuf,
    upstream: String,
    local_url: String,
    agent: Agent,
}

fn main() -> wry::Result<()> {
    let root = web_root();
    assert!(
        root.is_dir(),
        "Jellyfin Web assets not found: {}",
        root.display()
    );

    let upstream = saved_server_url();
    let server = Server::http("127.0.0.1:0").expect("create local Jellyfin proxy");
    let port = server
        .server_addr()
        .to_ip()
        .expect("local proxy must use an IP address")
        .port();
    let local_url = format!("http://127.0.0.1:{port}");

    let state = Arc::new(ProxyState {
        root,
        upstream,
        local_url: local_url.clone(),
        agent: ureq::agent(),
    });
    let server_state = state.clone();
    thread::Builder::new()
        .name("jellium-local-proxy".into())
        .spawn(move || {
            for request in server.incoming_requests() {
                let state = server_state.clone();
                let _ = thread::Builder::new()
                    .name("jellium-proxy-request".into())
                    .spawn(move || serve_request(request, &state));
            }
        })
        .expect("start local proxy thread");

    let event_loop = EventLoopBuilder::new().build();
    let window = WindowBuilder::new()
        .with_title("Jellium Desktop (WebView2)")
        .build(&event_loop)
        .expect("create WebView2 window");
    let start_url = format!("{local_url}/index.html");
    let webview = WebViewBuilder::new()
        .with_devtools(true)
        .with_autoplay(true)
        .with_clipboard(true)
        .with_url(&start_url)
        .build(&window)?;

    event_loop.run(move |event, _event_loop, control_flow| {
        *control_flow = ControlFlow::Wait;
        if let Event::WindowEvent {
            event: WindowEvent::CloseRequested,
            ..
        } = event
        {
            drop(webview);
            *control_flow = ControlFlow::Exit;
        }
    });
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

fn serve_static(
    request: TinyRequest,
    state: &ProxyState,
    relative: &str,
    path: &Path,
) {
    let mut bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => {
            respond_bytes(request, 500, "text/plain; charset=utf-8", b"read failed".to_vec());
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

    if request.method() == &TinyMethod::Head {
        respond_bytes(request, 200, mime_for(path), Vec::new());
    } else {
        respond_bytes(request, 200, mime_for(path), bytes);
    }
}

fn proxy_request(request: TinyRequest, state: &ProxyState, url: &str) {
    let upstream_url = format!("{}{}", state.upstream, url);
    let method = request.method().to_string();
    let mut body = Vec::new();
    if request.body_length().unwrap_or(0) > 0 {
        if request.as_reader().read_to_end(&mut body).is_err() {
            respond_bytes(request, 400, "text/plain; charset=utf-8", b"bad request body".to_vec());
            return;
        }
    }

    let mut builder = ureq::http::Request::builder()
        .method(method.as_str())
        .uri(upstream_url);
    for header in request.headers() {
        let name = header.field.as_str();
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
            let mut response = TinyResponse::from_reader(reader)
                .with_status_code(TinyStatusCode(status));
            for (name, value) in &headers {
                if should_forward_response_header(name.as_str())
                    && let Ok(header) = Header::from_bytes(
                        name.as_str().as_bytes(),
                        value.as_bytes(),
                    )
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
    if let Some(start) = bytes
        .windows(from.len())
        .position(|window| window == from)
    {
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
    let link = format!(r#"<link rel="stylesheet" href="{NORD_CSS_URL}">"#);
    bytes.splice(position..position, link.into_bytes());
    bytes
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

#[cfg(test)]
mod tests {
    use super::{patch_config, safe_relative_path};

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
    fn traversal_paths_are_rejected() {
        assert!(safe_relative_path("/../secret").is_none());
        assert_eq!(
            safe_relative_path("/node_modules.%40jellyfin.sdk.bundle.js"),
            Some("node_modules.@jellyfin.sdk.bundle.js".to_string())
        );
    }
}
