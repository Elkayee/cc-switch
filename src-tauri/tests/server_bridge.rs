//! Browser-mode bridge tests: dispatch over `get_ipc_response` and event
//! delivery over the SSE listener set.
//!
//! Only meaningful under `server-runtime`, where `AppRuntime` is `MockRuntime`.
#![cfg(feature = "server-runtime")]

use tauri::ipc::{CallbackFn, InvokeBody};
use tauri::webview::InvokeRequest;
use tauri::{Emitter, Listener, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn bridge_echo(value: String) -> String {
    format!("echo:{value}")
}

#[tauri::command]
fn bridge_fails() -> Result<String, String> {
    Err("intentional failure".into())
}

#[tauri::command]
async fn bridge_async_state(state: tauri::State<'_, Marker>) -> Result<String, String> {
    Ok(state.0.clone())
}

struct Marker(String);

fn build_app() -> tauri::App<cc_switch_lib::AppRuntime> {
    tauri::test::mock_builder()
        .invoke_handler(tauri::generate_handler![
            bridge_echo,
            bridge_fails,
            bridge_async_state
        ])
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("build mock app")
}

fn request(cmd: &str, args: serde_json::Value) -> InvokeRequest {
    InvokeRequest {
        cmd: cmd.into(),
        callback: CallbackFn(0),
        error: CallbackFn(1),
        url: "http://tauri.localhost".parse().unwrap(),
        body: InvokeBody::Json(args),
        headers: Default::default(),
        invoke_key: tauri::test::INVOKE_KEY.to_string(),
    }
}

/// The bridge sends exactly this shape, so a mismatch here is a real
/// browser-mode failure even though it passes on desktop.
#[test]
fn dispatch_returns_command_output() {
    let app = build_app();
    app.manage(Marker("managed".into()));
    let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .build()
        .expect("build webview");

    let response = tauri::test::get_ipc_response(
        &webview,
        request("bridge_echo", serde_json::json!({ "value": "hi" })),
    )
    .expect("command should succeed");

    assert_eq!(response.deserialize::<String>().unwrap(), "echo:hi");
}

#[test]
fn dispatch_surfaces_command_errors() {
    let app = build_app();
    let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .build()
        .expect("build webview");

    let error =
        tauri::test::get_ipc_response(&webview, request("bridge_fails", serde_json::json!({})))
            .expect_err("command should fail");

    assert_eq!(error, serde_json::json!("intentional failure"));
}

/// Async commands resolve through `tauri::async_runtime`, so this is what would
/// break if the server binary did not hand Tauri its own Tokio runtime.
#[test]
fn dispatch_resolves_async_commands_with_managed_state() {
    let app = build_app();
    app.manage(Marker("managed".into()));
    let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .build()
        .expect("build webview");

    let response = tauri::test::get_ipc_response(
        &webview,
        request("bridge_async_state", serde_json::json!({})),
    )
    .expect("async command should succeed");

    assert_eq!(response.deserialize::<String>().unwrap(), "managed");
}

#[test]
fn unknown_commands_are_rejected() {
    let app = build_app();
    let webview = WebviewWindowBuilder::new(&app, "main", WebviewUrl::App("index.html".into()))
        .build()
        .expect("build webview");

    let error = tauri::test::get_ipc_response(
        &webview,
        request("definitely_not_a_command", serde_json::json!({})),
    )
    .expect_err("unknown command should fail");

    assert!(
        error.to_string().contains("not found"),
        "unexpected error: {error}"
    );
}

/// Mirrors what `server::sse::events` does: subscribe with `listen_any`, expect
/// the emitted payload verbatim, and stop receiving after `unlisten`.
#[test]
fn events_reach_listeners_and_stop_after_unlisten() {
    let app = build_app();
    let handle = app.handle().clone();
    let (tx, rx) = std::sync::mpsc::channel::<String>();

    let id = handle.listen_any("provider-switched", move |event| {
        let _ = tx.send(event.payload().to_string());
    });

    handle
        .emit(
            "provider-switched",
            serde_json::json!({ "providerId": "p1" }),
        )
        .expect("emit should succeed");

    let payload = rx
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("listener should receive the event");
    let parsed: serde_json::Value = serde_json::from_str(&payload).expect("payload is JSON");
    assert_eq!(parsed["providerId"], "p1");

    handle.unlisten(id);
    handle
        .emit(
            "provider-switched",
            serde_json::json!({ "providerId": "p2" }),
        )
        .expect("emit should succeed");

    assert!(
        rx.recv_timeout(std::time::Duration::from_millis(200))
            .is_err(),
        "no further events should arrive after unlisten"
    );
}

/// Every event the SSE route subscribes to must be a name Tauri accepts;
/// `listen_any` panics on an invalid one.
#[test]
fn all_bridged_event_names_are_accepted_by_tauri() {
    let app = build_app();
    let handle = app.handle().clone();

    for name in cc_switch_lib::server::sse::BRIDGED_EVENTS {
        let id = handle.listen_any(*name, |_| {});
        handle.unlisten(id);
    }
}
