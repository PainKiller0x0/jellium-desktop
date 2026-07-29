//! `app://` scheme handler.
//!
//! Embedded resources are included at compile time from `src/web/*`. Two
//! URLs need dynamic generation:
//! - `app://resources/theme.css` — `:root{--bg-color:#RRGGBB}` from the
//!   compile-time background color constant.
//! - `app://resources/about.js` — a `var _aboutData = {...};` prefix
//!   prepended to the static about.js body.

use cef::*;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

// ---- embedded resources ----------------------------------------------------

struct Embedded {
    bytes: &'static [u8],
    mime: &'static str,
}

macro_rules! embedded {
    ($name:literal, $mime:literal) => {
        (
            $name,
            Embedded {
                bytes: include_bytes!(concat!("../../web/", $name)),
                mime: $mime,
            },
        )
    };
}

// URL key is the path after the `app://` scheme (no leading slash).
static RESOURCES: &[(&str, Embedded)] = &[
    embedded!("about.html", "text/html"),
    embedded!("about.js", "application/javascript"),
    embedded!("client-settings.js", "application/javascript"),
    embedded!("connectivityHelper.js", "application/javascript"),
    embedded!("context-menu.js", "application/javascript"),
    embedded!("input-plugin.js", "application/javascript"),
    embedded!("logo.png", "image/png"),
    embedded!("mpv-audio-player.js", "application/javascript"),
    embedded!("mpv-player-base.js", "application/javascript"),
    embedded!("mpv-video-player.js", "application/javascript"),
    embedded!("native-shim.js", "application/javascript"),
    embedded!("overlay.css", "text/css"),
    embedded!("overlay.html", "text/html"),
    embedded!("overlay.js", "application/javascript"),
    embedded!("overlay.lang.js", "application/javascript"),
];

fn lookup(url_path: &str) -> Option<&'static Embedded> {
    // URL key has the "resources/" prefix; strip it to match RESOURCES.
    let name = url_path.strip_prefix("resources/")?;
    RESOURCES.iter().find(|(n, _)| *n == name).map(|(_, r)| r)
}

fn jellyfin_web_root() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("JELLIUM_WEB_DIR") {
        let path = PathBuf::from(path);
        if path.is_dir() {
            return Some(path);
        }
    }

    if let Ok(exe) = std::env::current_exe()
        && let Some(parent) = exe.parent()
    {
        let path = parent.join("jellyfin-web");
        if path.is_dir() {
            return Some(path);
        }
    }

    // This fallback keeps `cargo run` useful during development, while
    // packaged builds use the directory next to the executable above.
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("resources")
        .join("jellyfin-web");
    path.is_dir().then_some(path)
}

fn safe_web_path(root: &Path, relative: &str) -> Option<PathBuf> {
    let path = Path::new(relative);
    if relative.is_empty()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return None;
    }
    Some(root.join(path))
}

fn web_config(root: &Path) -> Option<Vec<u8>> {
    use serde_json::{Value, json};

    let path = root.join("config.json");
    let mut config: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    let object = config.as_object_mut()?;
    let server_url = jfn_config::server_url();
    let servers = if server_url.is_empty() {
        Vec::new()
    } else {
        vec![json!(server_url)]
    };
    object.insert("servers".to_string(), Value::Array(servers));
    object.insert("multiserver".to_string(), Value::Bool(false));
    serde_json::to_vec(&config).ok()
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or("") {
        "html" => "text/html",
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
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "m3u8" => "application/vnd.apple.mpegurl",
        "ts" => "video/mp2t",
        _ => "application/octet-stream",
    }
}

fn lookup_jellyfin_web(url_path: &str) -> Option<(Vec<u8>, String)> {
    let relative = url_path.strip_prefix("resources/jellyfin-web/")?;
    let root = jellyfin_web_root()?;
    let path = safe_web_path(&root, relative)?;
    let bytes = if relative == "config.json" {
        web_config(&root)?
    } else {
        std::fs::read(&path).ok()?
    };
    Some((bytes, mime_for(&path).to_string()))
}

// Background color from src/color.h:40 — kBgColor{0x101010}.
const BG_COLOR_HEX: &str = "#101010";

fn theme_css() -> Vec<u8> {
    format!(":root{{--bg-color:{BG_COLOR_HEX}}}").into_bytes()
}

fn about_js_payload() -> Vec<u8> {
    use serde_json::json;

    let log_path = jfn_logging::active_path();
    let mut data = serde_json::Map::new();
    data.insert("app".into(), json!(crate::APP_VERSION_FULL));
    data.insert("cef".into(), crate::cef_version().into());
    data.insert(
        "configDir".into(),
        json!(abs_path(&jfn_paths::config_dir().to_string_lossy())),
    );
    if !log_path.is_empty() {
        data.insert("logFile".into(), json!(abs_path(&log_path)));
    }
    let json = serde_json::Value::Object(data).to_string();
    let prefix = format!("var _aboutData = {json};\n");

    let static_body = RESOURCES
        .iter()
        .find(|(n, _)| *n == "about.js")
        .map(|(_, r)| r.bytes)
        .unwrap_or(&[]);

    let mut out = Vec::with_capacity(prefix.len() + static_body.len());
    out.extend_from_slice(prefix.as_bytes());
    out.extend_from_slice(static_body);
    out
}

// Absolute-but-not-resolved: prepend CWD if relative, leave symlinks/../.
// alone. Fall back to input on error.
fn abs_path(p: &str) -> String {
    let pb = std::path::Path::new(p);
    if pb.is_absolute() {
        return p.to_string();
    }
    match std::env::current_dir() {
        Ok(cwd) => cwd.join(pb).to_string_lossy().into_owned(),
        Err(_) => p.to_string(),
    }
}

// ---- SchemeHandlerFactory --------------------------------------------------

#[derive(Clone)]
pub(crate) struct JfnSchemeFactory;

wrap_scheme_handler_factory! {
    pub(crate) struct JfnSchemeFactoryBuilder { inner: JfnSchemeFactory, }

    impl SchemeHandlerFactory {
        fn create(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _scheme_name: Option<&CefString>,
            request: Option<&mut Request>,
        ) -> Option<ResourceHandler> {
            let request = request?;
            let url_uf = request.url();
            let url = crate::app::userfree_to_string(&url_uf);

            // Strip scheme prefix and query/fragment.
            let after_scheme = url
                .find("://")
                .map(|p| &url[p + 3..])
                .unwrap_or(&url);
            let url_path = after_scheme
                .split(['?', '#'])
                .next()
                .unwrap_or("")
                .to_string();

            let (bytes, mime): (Vec<u8>, String) = if url_path == "resources/theme.css" {
                (theme_css(), "text/css".to_string())
            } else if url_path == "resources/about.js" {
                (about_js_payload(), "application/javascript".to_string())
            } else if let Some(resource) = lookup_jellyfin_web(&url_path) {
                resource
            } else if let Some(r) = lookup(&url_path) {
                (r.bytes.to_vec(), r.mime.to_string())
            } else {
                jfn_logging::log(
                    jfn_logging::CATEGORY_RESOURCE,
                    jfn_logging::LEVEL_WARN,
                    &format!("EmbeddedScheme not found: {url_path}"),
                );
                return None;
            };

            Some(
                JfnResourceHandlerBuilder::new(JfnResourceHandler {
                    bytes: Arc::new(bytes),
                    mime,
                    offset: Arc::new(AtomicUsize::new(0)),
                }),
            )
        }
    }
}

// ---- ResourceHandler -------------------------------------------------------

#[derive(Clone)]
pub(crate) struct JfnResourceHandler {
    bytes: Arc<Vec<u8>>,
    mime: String,
    offset: Arc<AtomicUsize>,
}

wrap_resource_handler! {
    pub(crate) struct JfnResourceHandlerBuilder { inner: JfnResourceHandler, }

    impl ResourceHandler {
        fn open(
            &self,
            _request: Option<&mut Request>,
            handle_request: Option<&mut ::std::os::raw::c_int>,
            _callback: Option<&mut Callback>,
        ) -> ::std::os::raw::c_int {
            if let Some(h) = handle_request { *h = 1; }
            1
        }

        fn response_headers(
            &self,
            response: Option<&mut Response>,
            response_length: Option<&mut i64>,
            _redirect_url: Option<&mut CefString>,
        ) {
            let len = self.inner.bytes.len() as i64;
            if let Some(rsp) = response {
                rsp.set_status(200);
                rsp.set_status_text(Some(&CefString::from("OK")));
                rsp.set_mime_type(Some(&CefString::from(self.inner.mime.as_str())));
            }
            if let Some(rl) = response_length { *rl = len; }
        }

        fn read(
            &self,
            data_out: *mut u8,
            bytes_to_read: ::std::os::raw::c_int,
            bytes_read: Option<&mut ::std::os::raw::c_int>,
            _callback: Option<&mut ResourceReadCallback>,
        ) -> ::std::os::raw::c_int {
            let offset = self.inner.offset.load(Ordering::Relaxed);
            let total = self.inner.bytes.len();
            if offset >= total {
                if let Some(br) = bytes_read { *br = 0; }
                return 0;
            }
            let remaining = total - offset;
            let n = remaining.min(bytes_to_read as usize);
            unsafe {
                std::ptr::copy_nonoverlapping(
                    self.inner.bytes.as_ptr().add(offset),
                    data_out,
                    n,
                );
            }
            self.inner.offset.store(offset + n, Ordering::Relaxed);
            if let Some(br) = bytes_read { *br = n as i32; }
            1
        }
    }
}

// ---- registration ----------------------------------------------------------

pub(crate) fn register() {
    let scheme = CefString::from("app");
    let domain = CefString::from("");
    register_scheme_handler_factory(
        Some(&scheme),
        Some(&domain),
        Some(&mut JfnSchemeFactoryBuilder::new(JfnSchemeFactory)),
    );
}
