//! Browser (server) mode: serves the built frontend over HTTP and bridges it to
//! the same Tauri commands the desktop app uses.
//!
//! Only compiled under the `server-runtime` feature, where `AppRuntime` is
//! `tauri::test::MockRuntime` — the app runs headless, with no OS window.

pub mod auth;
pub mod bridge;
mod handler;
pub mod options;
pub mod runtime;
pub mod sse;

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
    Router,
};
use tauri::AppHandle;
use tower_http::services::{ServeDir, ServeFile};

use crate::AppRuntime;
use auth::AuthToken;
use bridge::IpcWebview;
use options::ServerOptions;

/// Upper bound on an `/api/invoke` body. Well above any real command payload
/// (config imports are the largest) while still bounding memory per request;
/// axum's 2 MiB default is too small for zip/config imports.
const MAX_INVOKE_BODY_BYTES: usize = 64 * 1024 * 1024;

pub struct ServerHandles {
    pub app: AppHandle<AppRuntime>,
    pub webview: IpcWebview,
    /// `None` when `--token` was not passed, i.e. `/api/*` is unauthenticated.
    pub token: Option<AuthToken>,
    pub options: ServerOptions,
}

/// The single origin every browser tab should end up on.
///
/// `localhost` and `127.0.0.1` are different origins to a browser, so they get
/// separate `localStorage` — a token saved under one is invisible to the other.
/// Redirecting to one canonical form keeps the saved token findable however the
/// user reached us.
#[derive(Clone, Debug)]
pub struct CanonicalOrigin {
    /// Unbracketed, e.g. `127.0.0.1` or `::1`.
    pub host: String,
    /// The port actually bound, which `--port 0` only settles at bind time.
    pub port: u16,
}

impl CanonicalOrigin {
    fn authority(&self) -> String {
        format_authority(&self.host, self.port)
    }
}

fn format_authority(host: &str, port: u16) -> String {
    if host.contains(':') {
        // IPv6 literals need brackets to sit next to a port in a URL.
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

/// Splits a `Host` header into its host and (optional) port.
fn split_authority(authority: &str) -> (String, Option<u16>) {
    if let Some(rest) = authority.strip_prefix('[') {
        // `[::1]` or `[::1]:8080`
        if let Some((host, tail)) = rest.split_once(']') {
            let port = tail.strip_prefix(':').and_then(|p| p.parse().ok());
            return (host.to_ascii_lowercase(), port);
        }
    }

    match authority.rsplit_once(':') {
        Some((host, port)) => (host.to_ascii_lowercase(), port.parse().ok()),
        None => (authority.to_ascii_lowercase(), None),
    }
}

/// Whether this name means "the machine I am already on".
fn is_loopback_alias(host: &str) -> bool {
    if host == "localhost" || host.ends_with(".localhost") {
        return true;
    }
    host.parse::<IpAddr>()
        .map(|ip| ip.is_loopback())
        .unwrap_or(false)
}

/// The authority to redirect to, or `None` to serve the request as-is.
///
/// Only rewrites one loopback spelling into another. A LAN address, a real
/// hostname, or a mismatched port all pass through untouched: those mean a
/// non-loopback bind, a reverse proxy, or an SSH tunnel like
/// `ssh -L 9999:localhost:55830`, and in the tunnel case redirecting to the
/// origin's own port would send the browser somewhere it cannot reach.
fn redirect_target(host_header: Option<&str>, canonical: &CanonicalOrigin) -> Option<String> {
    let (host, port) = split_authority(host_header?);

    if host == canonical.host.to_ascii_lowercase() {
        return None;
    }
    if !is_loopback_alias(&host) {
        return None;
    }
    // A bare `Host: localhost` implies the scheme default.
    if port.unwrap_or(80) != canonical.port {
        return None;
    }

    Some(canonical.authority())
}

async fn canonical_host(
    State(canonical): State<CanonicalOrigin>,
    request: Request,
    next: Next,
) -> Response {
    let host = request
        .headers()
        .get(header::HOST)
        .and_then(|value| value.to_str().ok());

    if let Some(authority) = redirect_target(host, &canonical) {
        let path_and_query = request
            .uri()
            .path_and_query()
            .map(|p| p.as_str())
            .unwrap_or("/");
        // 307 rather than 302: it preserves the method and body, so a POST to
        // `/api/invoke` that arrives on the other spelling still lands.
        return (
            StatusCode::TEMPORARY_REDIRECT,
            [(
                header::LOCATION,
                format!("http://{authority}{path_and_query}"),
            )],
        )
            .into_response();
    }

    next.run(request).await
}

/// Builds the router: JSON-RPC + SSE under `/api`, static frontend everywhere
/// else, with the token check attached only when one was configured.
pub fn build_router(
    handles: &ServerHandles,
    static_dir: Option<PathBuf>,
    canonical: CanonicalOrigin,
) -> Router {
    let api = Router::new()
        .route("/invoke", post(bridge::invoke))
        .layer(axum::extract::DefaultBodyLimit::max(MAX_INVOKE_BODY_BYTES))
        .with_state(handles.webview.clone())
        .merge(
            Router::new()
                .route("/events", get(sse::events))
                .with_state(handles.app.clone()),
        );

    // Applied last so it wraps both routes above.
    let api = match handles.token.clone() {
        Some(token) => api.layer(axum::middleware::from_fn_with_state(
            token,
            auth::require_token,
        )),
        None => api,
    };

    let router = Router::new().nest("/api", api);

    let router = match static_dir {
        Some(dir) => {
            // SPA fallback: unknown paths serve index.html so client-side
            // routing survives a reload.
            let index = dir.join("index.html");
            router.fallback_service(ServeDir::new(dir).fallback(ServeFile::new(index)))
        }
        None => router,
    };

    // Outermost, so both the API and the static frontend are reached on one
    // origin and therefore share one `localStorage`.
    router.layer(axum::middleware::from_fn_with_state(
        canonical,
        canonical_host,
    ))
}

/// Resolves where the built frontend lives.
///
/// In the npm package the binary and `dist/` ship side by side, so prefer a
/// sibling of the executable; `CC_SWITCH_WEB_DIST` overrides for local dev.
pub fn resolve_static_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CC_SWITCH_WEB_DIST") {
        let dir = PathBuf::from(dir);
        if dir.join("index.html").is_file() {
            return Some(dir);
        }
        log::warn!(
            "[Server] CC_SWITCH_WEB_DIST is set but has no index.html: {}",
            dir.display()
        );
    }

    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    [exe_dir.join("dist"), exe_dir.join("web")]
        .into_iter()
        .find(|candidate| candidate.join("index.html").is_file())
}

/// Binds the listener and serves until the process exits.
pub async fn serve(handles: ServerHandles) -> std::io::Result<()> {
    let static_dir = resolve_static_dir();
    if static_dir.is_none() {
        log::warn!("[Server] No frontend build found; serving API only");
    }

    let addr = SocketAddr::from((handles.options.host, handles.options.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;

    let canonical = CanonicalOrigin {
        host: display_host(&handles.options),
        port: local_addr.port(),
    };

    let url = match &handles.token {
        Some(token) => format!("http://{}/?token={}", canonical.authority(), token.as_str()),
        None => format!("http://{}/", canonical.authority()),
    };

    // Printed rather than logged: this is the one line the user must see to
    // reach the UI, and it must not depend on the configured log level.
    println!("\n  Cli-Switch is running at:\n\n    {url}\n");

    match (handles.options.host.is_loopback(), handles.token.is_some()) {
        (true, true) => {}
        (true, false) => println!(
            "  No token set: any process on this machine can read and change your\n  \
             provider configuration, including API keys. Pass --token <TOKEN> to\n  \
             require one.\n"
        ),
        (false, true) => println!(
            "  Warning: bound to {} — anyone who can reach this port and the\n  \
             token above can change your provider configuration.\n",
            handles.options.host
        ),
        (false, false) => println!(
            "  Warning: bound to {} with no token — anyone who can reach this port\n  \
             can read and change your provider configuration, including API keys.\n  \
             Pass --token <TOKEN> to require one.\n",
            handles.options.host
        ),
    }

    if handles.options.open {
        open_browser(&url);
    }

    let router = build_router(&handles, static_dir, canonical);
    axum::serve(listener, router).await
}

fn display_host(options: &ServerOptions) -> String {
    if options.host.is_unspecified() {
        // 0.0.0.0 is not a URL a browser can open.
        "127.0.0.1".to_string()
    } else {
        options.host.to_string()
    }
}

fn open_browser(url: &str) {
    // `open`/`start`/`xdg-open` rather than the opener plugin: this runs before
    // any webview exists, and keeps the failure non-fatal.
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", url])
        .spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();

    if let Err(e) = result {
        log::warn!("[Server] Could not open a browser automatically: {e}");
        println!("  Open the URL above manually.");
    }
}

#[cfg(test)]
mod tests {
    use super::{redirect_target, split_authority, CanonicalOrigin};

    fn canonical() -> CanonicalOrigin {
        CanonicalOrigin {
            host: "127.0.0.1".to_string(),
            port: 55830,
        }
    }

    #[test]
    fn splits_host_and_port() {
        assert_eq!(
            split_authority("localhost:55830"),
            ("localhost".to_string(), Some(55830))
        );
        assert_eq!(
            split_authority("localhost"),
            ("localhost".to_string(), None)
        );
        assert_eq!(
            split_authority("[::1]:55830"),
            ("::1".to_string(), Some(55830))
        );
        assert_eq!(split_authority("[::1]"), ("::1".to_string(), None));
        // Host headers are case-insensitive.
        assert_eq!(
            split_authority("LocalHost:55830"),
            ("localhost".to_string(), Some(55830))
        );
    }

    #[test]
    fn redirects_a_loopback_alias_to_the_canonical_host() {
        assert_eq!(
            redirect_target(Some("localhost:55830"), &canonical()).as_deref(),
            Some("127.0.0.1:55830")
        );
        assert_eq!(
            redirect_target(Some("[::1]:55830"), &canonical()).as_deref(),
            Some("127.0.0.1:55830")
        );
        // Another loopback IPv4 address, which Linux routes to the same host.
        assert_eq!(
            redirect_target(Some("127.0.0.2:55830"), &canonical()).as_deref(),
            Some("127.0.0.1:55830")
        );
    }

    #[test]
    fn leaves_the_canonical_host_alone() {
        assert_eq!(redirect_target(Some("127.0.0.1:55830"), &canonical()), None);
    }

    /// A different port means a tunnel or proxy in front of us; rewriting the
    /// port would point the browser at something it cannot reach.
    #[test]
    fn leaves_a_forwarded_port_alone() {
        assert_eq!(redirect_target(Some("localhost:9999"), &canonical()), None);
        assert_eq!(redirect_target(Some("localhost"), &canonical()), None);
    }

    #[test]
    fn leaves_non_loopback_hosts_alone() {
        // Reached over the LAN after `--host any`, or through a named proxy.
        assert_eq!(
            redirect_target(Some("192.168.1.5:55830"), &canonical()),
            None
        );
        assert_eq!(
            redirect_target(Some("cc-switch.internal:55830"), &canonical()),
            None
        );
    }

    #[test]
    fn serves_normally_when_no_host_header_is_present() {
        assert_eq!(redirect_target(None, &canonical()), None);
    }

    #[test]
    fn ipv6_canonical_host_is_bracketed_in_the_target() {
        let canonical = CanonicalOrigin {
            host: "::1".to_string(),
            port: 55830,
        };
        assert_eq!(
            redirect_target(Some("localhost:55830"), &canonical).as_deref(),
            Some("[::1]:55830")
        );
    }
}
