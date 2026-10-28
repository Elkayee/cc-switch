//! `POST /api/invoke` — the HTTP face of Tauri's IPC.
//!
//! Rather than re-implementing a dispatch table for the ~290 registered
//! commands, this forwards into `tauri::test::get_ipc_response`, i.e. the same
//! `Webview::on_message` path the desktop webview uses. Every command in
//! `generate_handler!` is therefore reachable over HTTP with no per-command
//! code here, and command argument/return (de)serialization stays byte-for-byte
//! identical to desktop.

use axum::{
    extract::State,
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::Value;
use tauri::{
    ipc::{CallbackFn, InvokeBody, InvokeResponseBody},
    webview::InvokeRequest,
    Webview,
};

use crate::AppRuntime;

/// Commands that only mean something for a native desktop window.
///
/// Kept as a single explicit list (rather than a whitelist of the other ~283)
/// so that any command added upstream is reachable in browser mode by default,
/// and only deliberately-native ones need touching here.
const NATIVE_ONLY_COMMANDS: &[&str] = &[
    // Native folder/file pickers — no browser equivalent without the
    // File System Access API, which is out of scope.
    "pick_directory",
    "save_file_dialog",
    "open_file_dialog",
    "open_zip_file_dialog",
    // Destroy/rebuild the native window and hide the taskbar icon.
    "enter_lightweight_mode",
    "exit_lightweight_mode",
    // Native title-bar theming: there is no OS window to re-theme.
    "set_window_theme",
    // Desktop process lifecycle. In browser mode the process is owned by npx,
    // and updates come from npm.
    "restart_app",
];

pub fn is_native_only(cmd: &str) -> bool {
    NATIVE_ONLY_COMMANDS.contains(&cmd)
}

/// Holds the webview used as the IPC entry point.
///
/// `get_ipc_response` is bounded on `AsRef<Webview<MockRuntime>>`, and there is
/// no blanket `AsRef<T> for T`, so a newtype supplies it. Wrapping `Webview`
/// (rather than `WebviewWindow`) keeps the state `Send + Sync`.
#[derive(Clone)]
pub struct IpcWebview(Webview<AppRuntime>);

impl IpcWebview {
    pub fn new(webview: Webview<AppRuntime>) -> Self {
        Self(webview)
    }
}

impl AsRef<Webview<AppRuntime>> for IpcWebview {
    fn as_ref(&self) -> &Webview<AppRuntime> {
        &self.0
    }
}

#[derive(Deserialize)]
pub struct InvokePayload {
    pub cmd: String,
    /// Command arguments, keyed exactly as the desktop `invoke()` sends them.
    #[serde(default)]
    pub args: Value,
}

pub async fn invoke(
    State(webview): State<IpcWebview>,
    Json(payload): Json<InvokePayload>,
) -> Response {
    if is_native_only(&payload.cmd) {
        return error_response(
            StatusCode::NOT_IMPLEMENTED,
            Value::String(format!(
                "command `{}` is not supported in browser mode",
                payload.cmd
            )),
        );
    }

    let request = InvokeRequest {
        cmd: payload.cmd.clone(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        // Same origin the desktop webview reports; commands that inspect the
        // caller URL therefore see what they expect.
        url: "http://tauri.localhost"
            .parse()
            .expect("static URL literal is valid"),
        body: InvokeBody::Json(payload.args),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_string(),
    };

    // `get_ipc_response` blocks the calling thread until the command resolves,
    // so it must not run on an async worker: async commands resolve *on* that
    // runtime and would otherwise be starved of the thread they need.
    let dispatched =
        tokio::task::spawn_blocking(move || tauri::test::get_ipc_response(&webview, request)).await;

    match dispatched {
        Ok(Ok(body)) => success_response(body),
        Ok(Err(error)) => error_response(StatusCode::BAD_REQUEST, error),
        Err(join_error) => {
            log::error!("[Server] invoke dispatch task failed: {join_error}");
            error_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                Value::String(format!("command dispatch failed: {join_error}")),
            )
        }
    }
}

fn success_response(body: InvokeResponseBody) -> Response {
    match body {
        // Already-serialized JSON: forwarding the string avoids a
        // parse/re-serialize round trip that could reorder or reshape it.
        InvokeResponseBody::Json(json) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/json")],
            json,
        )
            .into_response(),
        InvokeResponseBody::Raw(bytes) => (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/octet-stream")],
            bytes,
        )
            .into_response(),
    }
}

/// Errors are enveloped as `{"error": <value>}` so the webshim can reject with
/// the inner value and match what Tauri's real `invoke()` rejects with.
fn error_response(status: StatusCode, error: Value) -> Response {
    (status, Json(serde_json::json!({ "error": error }))).into_response()
}

#[cfg(test)]
mod tests {
    use super::{is_native_only, InvokePayload, NATIVE_ONLY_COMMANDS};

    #[test]
    fn native_only_list_is_rejected() {
        for cmd in NATIVE_ONLY_COMMANDS {
            assert!(is_native_only(cmd), "{cmd} should be native-only");
        }
    }

    #[test]
    fn ordinary_commands_are_allowed() {
        for cmd in [
            "get_providers",
            "switch_provider",
            "get_settings",
            "open_external",
            "get_mcp_servers",
        ] {
            assert!(!is_native_only(cmd), "{cmd} should be bridged");
        }
    }

    #[test]
    fn native_only_list_has_no_duplicates() {
        let mut sorted = NATIVE_ONLY_COMMANDS.to_vec();
        sorted.sort_unstable();
        let total = sorted.len();
        sorted.dedup();
        assert_eq!(sorted.len(), total);
    }

    #[test]
    fn payload_defaults_args_when_absent() {
        let payload: InvokePayload = serde_json::from_str(r#"{"cmd":"get_providers"}"#).unwrap();
        assert_eq!(payload.cmd, "get_providers");
        assert!(payload.args.is_null());
    }

    #[test]
    fn payload_preserves_args() {
        let payload: InvokePayload =
            serde_json::from_str(r#"{"cmd":"get_providers","args":{"app":"claude"}}"#).unwrap();
        assert_eq!(payload.args["app"], "claude");
    }
}
