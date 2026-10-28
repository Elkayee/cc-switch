//! Headless app bootstrap: builds a real Tauri `App` on the `MockRuntime`, with
//! the same managed state the desktop `run()` installs, then serves HTTP.
//!
//! Kept inside the library (rather than in `src/bin/server.rs`) because
//! `generate_handler!` rewrites each path's last segment into a `macro_rules!`
//! wrapper defined next to the command. Resolving those from a separate binary
//! target is fragile, whereas here the paths are identical to `run()`'s.

use std::sync::Arc;

use tauri::Manager;

use super::auth::AuthToken;
use super::bridge::IpcWebview;
use super::options::{self, ParseOutcome, ServerOptions};
use super::{serve, ServerHandles};
use crate::store::AppState;
use crate::AppRuntime;

/// Label for the webview that receives bridged IPC.
///
/// `tauri.conf.json` declares a single `main` window, which Tauri creates during
/// setup; reusing that label means the bridge dispatches through the same
/// webview identity the desktop app uses.
const IPC_WEBVIEW_LABEL: &str = "main";

/// Entry point for the `cli-switch` binary.
pub fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match options::parse(&args) {
        Ok(ParseOutcome::Run(options)) => options,
        Ok(ParseOutcome::Help) => {
            print!("{}", options::HELP);
            return;
        }
        Err(message) => {
            eprintln!("error: {message}\n");
            print!("{}", options::HELP);
            std::process::exit(2);
        }
    };

    // One Tokio runtime shared with Tauri: async commands resolve via
    // `tauri::async_runtime::spawn`, so without this Tauri would build a second
    // runtime and the two would not see each other's tasks.
    let runtime = match tokio::runtime::Runtime::new() {
        Ok(runtime) => runtime,
        Err(e) => {
            eprintln!("error: could not start the async runtime: {e}");
            std::process::exit(1);
        }
    };
    tauri::async_runtime::set(runtime.handle().clone());

    if let Err(e) = run_headless(runtime, options) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}

/// What `.setup()` hands back once state is managed and the IPC webview
/// exists.
struct Ready {
    app_handle: tauri::AppHandle<AppRuntime>,
    webview: tauri::Webview<AppRuntime>,
}

fn run_headless(
    runtime: tokio::runtime::Runtime,
    options: ServerOptions,
) -> Result<(), Box<dyn std::error::Error>> {
    crate::panic_hook::setup_panic_hook();
    let _ = rustls::crypto::ring::default_provider().install_default();

    // `.setup()` (state init + the config-declared `main` webview) only runs
    // as a reaction to the runtime's `Ready` event, which `tauri::App::build`
    // does not emit — only `run`/`run_return` do. So the app has to actually
    // be run to reach a usable state, and since `run` blocks for the process
    // lifetime, it gets a dedicated thread; this channel is how that thread
    // hands the now-ready `AppHandle`/webview back to the one serving HTTP.
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<Ready, String>>();

    let app = build_app(ready_tx)?;
    std::thread::Builder::new()
        .name("tauri-event-loop".into())
        .spawn(move || app.run(|_app_handle, _event| {}))?;

    let ready = ready_rx
        .recv()
        .map_err(|_| "app setup ended without reporting readiness".to_string())??;

    let token = options.token.clone().map(AuthToken::new);
    let handles = ServerHandles {
        app: ready.app_handle,
        webview: IpcWebview::new(ready.webview),
        token,
        options,
    };

    runtime.block_on(serve(handles))?;
    Ok(())
}

fn build_app(
    ready_tx: std::sync::mpsc::Sender<Result<Ready, String>>,
) -> Result<tauri::App<AppRuntime>, Box<dyn std::error::Error>> {
    let builder = tauri::test::mock_builder()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            // Every fallible step is funneled through this closure so a
            // failure reports through the channel (and thus as a normal
            // startup error) instead of unwinding as a panic on the event-loop
            // thread, which `ready_rx.recv()` could otherwise only observe as
            // an opaque disconnect.
            let outcome = (|| -> Result<Ready, String> {
                crate::app_store::refresh_app_config_dir_override(app.handle());
                crate::panic_hook::init_app_config_dir(crate::config::get_app_config_dir());
                init_logging(app.handle()).map_err(|e| e.to_string())?;
                // First read happens before the logger exists; replay so any
                // Store/path warnings actually reach the log file.
                let _ = crate::app_store::refresh_app_config_dir_override(app.handle());

                crate::usage_events::init(app.handle().clone());

                // Unlike desktop, failures here cannot fall back to a modal
                // retry prompt — there is no UI yet. They abort startup with a
                // message on stderr instead.
                let db = Arc::new(crate::database::Database::init().map_err(|e| e.to_string())?);
                apply_log_level(&db);

                let app_state = crate::build_app_state(app.handle(), db);
                if let Err(e) = crate::app_store::migrate_app_config_dir_from_settings(app.handle())
                {
                    log::warn!("迁移 app_config_dir 失败: {e}");
                }

                crate::services::webdav_auto_sync::start_worker(
                    app_state.db.clone(),
                    app.handle().clone(),
                );
                crate::services::s3_auto_sync::start_worker(
                    app_state.db.clone(),
                    app.handle().clone(),
                );
                app.manage(app_state);

                manage_auxiliary_state(app);
                init_outbound_proxy(app);
                spawn_background_workers(app);

                // Created by Tauri's own internal setup step from
                // `tauri.conf.json`'s declared `main` window, immediately
                // before this closure runs — nothing here builds it.
                let webview = app
                    .get_webview_window(IPC_WEBVIEW_LABEL)
                    .ok_or_else(|| "the `main` webview was not created".to_string())?;

                Ok(Ready {
                    app_handle: app.handle().clone(),
                    webview: webview.as_ref().clone(),
                })
            })();

            let _ = ready_tx.send(outcome);
            Ok(())
        })
        .invoke_handler(super::handler::invoke_handler());

    // Reuses `lib.rs`'s single `generate_context!()` call rather than expanding
    // the macro again: on macOS a second expansion redefines the
    // `_EMBED_INFO_PLIST` symbol and the crate fails to link. See
    // `crate::tauri_context`.
    Ok(builder.build(crate::tauri_context())?)
}

fn init_logging(app: &tauri::AppHandle<AppRuntime>) -> tauri::Result<()> {
    use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};

    let log_dir = crate::panic_hook::get_log_dir();
    if let Err(e) = std::fs::create_dir_all(&log_dir) {
        eprintln!("创建日志目录失败: {e}");
    }

    app.plugin(
        tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Trace)
            .targets([
                Target::new(TargetKind::Stdout),
                Target::new(TargetKind::Folder {
                    path: log_dir,
                    file_name: Some("cc-switch".into()),
                }),
            ])
            .rotation_strategy(RotationStrategy::KeepSome(4))
            .max_file_size(20 * 1024 * 1024)
            .timezone_strategy(TimezoneStrategy::UseLocal)
            .build(),
    )?;

    log::set_max_level(log::LevelFilter::Info);
    log::info!(
        "=== CC Switch v{} started (server mode) ===",
        env!("CARGO_PKG_VERSION")
    );
    Ok(())
}

fn apply_log_level(db: &crate::database::Database) {
    match db.get_log_config() {
        Ok(log_config) => {
            log::set_max_level(log_config.to_level_filter());
            log::info!(
                "已加载日志配置: enabled={}, level={}",
                log_config.enabled,
                log_config.level
            );
        }
        Err(e) => {
            log::set_max_level(log::LevelFilter::Info);
            log::warn!("读取日志配置失败，已回退到 info: {e}");
        }
    }
}

/// The four extra managed states desktop installs, which many commands take as
/// `State<'_, T>` and would otherwise panic on.
fn manage_auxiliary_state(app: &tauri::App<AppRuntime>) {
    use crate::commands::{CodexOAuthState, CopilotAuthState, SkillServiceState, XaiOAuthState};
    use crate::proxy::providers::{
        copilot_auth::CopilotAuthManager, xai_oauth_auth::XaiOAuthManager,
    };
    use tokio::sync::RwLock;

    let skill_service = Arc::new(crate::services::SkillService::new());
    app.manage(SkillServiceState(skill_service.clone()));
    crate::services::skill_auto_update::start_worker(
        app.state::<AppState>().db.clone(),
        skill_service,
        app.handle().clone(),
    );

    let app_config_dir = crate::config::get_app_config_dir();
    app.manage(CopilotAuthState(Arc::new(RwLock::new(
        CopilotAuthManager::new(app_config_dir.clone()),
    ))));
    // Upstream moved the manager into `AppState` so `ProxyService` shares one
    // instance; reuse it here instead of constructing a second manager.
    app.manage(CodexOAuthState(
        app.state::<AppState>().codex_oauth_manager.clone(),
    ));
    app.manage(XaiOAuthState(Arc::new(RwLock::new(XaiOAuthManager::new(
        app_config_dir,
    )))));
}

fn init_outbound_proxy(app: &tauri::App<AppRuntime>) {
    let db = &app.state::<AppState>().db;
    let proxy_url = db.get_global_proxy_url().ok().flatten();

    if let Err(e) = crate::proxy::http_client::init(proxy_url.as_deref()) {
        log::error!("[GlobalProxy] [GP-005] Failed to initialize with saved config: {e}");
        if proxy_url.is_some() {
            log::warn!("[GlobalProxy] [GP-006] Clearing invalid proxy config from database");
            if let Err(clear_err) = db.set_global_proxy_url(None) {
                log::error!("[GlobalProxy] [GP-007] Failed to clear invalid config: {clear_err}");
            }
        }
        if let Err(fallback_err) = crate::proxy::http_client::init(None) {
            log::error!(
                "[GlobalProxy] [GP-008] Failed to initialize direct connection: {fallback_err}"
            );
        }
    }
}

/// Crash recovery and proxy restore, mirroring desktop startup. The periodic
/// backup and session-sync timers desktop also starts are deliberately left
/// out: they belong to a long-lived desktop session, not a short-lived CLI one.
fn spawn_background_workers(app: &tauri::App<AppRuntime>) {
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let state = app_handle.state::<AppState>();

        // Must run before auto-extract: credentials leaked into the Gemini
        // shared snippet would otherwise be copied back into live config.
        if let Err(e) =
            crate::services::provider::ProviderService::scrub_leaked_gemini_common_config(&state)
                .await
        {
            log::warn!("清理 Gemini 通用配置泄漏凭据失败: {e}");
        }

        crate::initialize_common_config_snippets(&state);

        // Settle each app's direct/proxy mode (including leftover takeover
        // from older versions), then attach proxy-mode apps. After snippet
        // extract so it reads the direct live files.
        crate::mode::controller::startup(&state).await;
    });
}
