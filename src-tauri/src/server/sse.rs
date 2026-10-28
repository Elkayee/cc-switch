//! `GET /api/events` — Tauri's event bus as Server-Sent Events.
//!
//! The desktop frontend calls `listen(name, cb)` from `@tauri-apps/api/event`.
//! In browser mode the webshim backs that with a single `EventSource` on this
//! route and fans events out client-side by name, so the backend keeps exactly
//! one subscription set per connected tab.

use std::convert::Infallible;

use axum::{
    extract::State,
    response::{
        sse::{Event as SseEvent, KeepAlive, Sse},
        IntoResponse, Response,
    },
};
use tauri::{AppHandle, EventId, Listener};

use crate::AppRuntime;

/// Events the backend emits to the frontend.
///
/// Listing them explicitly (instead of a catch-all) keeps internal chatter off
/// the wire. Cross-checked against every `emit`/`emit_to` call site in `src/`.
pub const BRIDGED_EVENTS: &[&str] = &[
    "provider-switched",
    "profile-applied",
    "universal-provider-synced",
    "proxy-flags-changed",
    "proxy-official-warning",
    "usage-cache-updated",
    "usage-log-recorded",
    "webdav-sync-status-updated",
    "s3-sync-status-updated",
    "tray-navigate",
    "deeplink-import",
    "deeplink-error",
    "skill-auto-update-status",
];

/// Buffered events per connection. Generous enough to absorb a burst (a sync
/// finishing while the tab is busy rendering) without unbounded growth if a
/// client stops reading entirely.
const CHANNEL_CAPACITY: usize = 1024;

/// Unsubscribes this connection's listeners when the stream is dropped, i.e.
/// when the tab closes or navigates. Without this, every reconnect would leave
/// its listeners behind and events would be delivered many times over.
struct ListenerGuard {
    app: AppHandle<AppRuntime>,
    ids: Vec<EventId>,
}

impl Drop for ListenerGuard {
    fn drop(&mut self) {
        for id in self.ids.drain(..) {
            self.app.unlisten(id);
        }
    }
}

pub async fn events(State(app): State<AppHandle<AppRuntime>>) -> Response {
    let (tx, rx) = tokio::sync::mpsc::channel::<SseEvent>(CHANNEL_CAPACITY);

    let mut ids = Vec::with_capacity(BRIDGED_EVENTS.len());
    for name in BRIDGED_EVENTS {
        let tx = tx.clone();
        let name = *name;
        ids.push(app.listen_any(name, move |event| {
            // Payload is already a JSON string from Tauri's emitter; forward it
            // verbatim so the webshim can `JSON.parse` it like the real client.
            let frame = SseEvent::default().event(name).data(event.payload());
            if tx.try_send(frame).is_err() {
                log::debug!("[Server] SSE buffer full or closed, dropped `{name}`");
            }
        }));
    }

    let guard = ListenerGuard {
        app: app.clone(),
        ids,
    };

    // The `async_stream::stream!` block owns `guard`, `rx`, and `tx` for as
    // long as the connection is polled, so listener lifetime matches
    // connection lifetime exactly and unlistens on drop either way.
    let stream = async_stream::stream! {
        let _keep_alive = guard;
        let mut rx = rx;
        // Dropped once the last clone (the ones captured by each listener
        // closure) goes away with `guard`; kept here only so `rx.recv()` below
        // does not race a sender close on the very first poll.
        drop(tx);
        while let Some(event) = rx.recv().await {
            yield Ok::<_, Infallible>(event);
        }
    };

    Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::BRIDGED_EVENTS;

    #[test]
    fn bridged_events_have_no_duplicates() {
        let mut sorted = BRIDGED_EVENTS.to_vec();
        sorted.sort_unstable();
        let total = sorted.len();
        sorted.dedup();
        assert_eq!(sorted.len(), total);
    }

    /// Tauri panics on event names containing characters outside this set, and
    /// SSE frames are newline-delimited, so a bad name here would fail at
    /// runtime on the first emit rather than at compile time.
    #[test]
    fn bridged_event_names_are_wire_safe() {
        for name in BRIDGED_EVENTS {
            assert!(!name.is_empty());
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '/' | ':' | '_')),
                "`{name}` is not a valid Tauri event name"
            );
        }
    }

    /// Guards against a Rust-side `emit` being added without a matching entry
    /// here, which would silently never reach the browser.
    #[test]
    fn every_emitted_event_is_bridged() {
        let mut missing = Vec::new();
        for source in [
            include_str!("../lib.rs"),
            include_str!("../tray.rs"),
            include_str!("../usage_events.rs"),
            include_str!("../commands/failover.rs"),
            include_str!("../commands/profile.rs"),
            include_str!("../commands/provider.rs"),
            include_str!("../commands/settings.rs"),
            include_str!("../commands/subscription.rs"),
            include_str!("../proxy/failover_switch.rs"),
            include_str!("../services/proxy.rs"),
            include_str!("../services/webdav_auto_sync.rs"),
            include_str!("../services/s3_auto_sync.rs"),
            include_str!("../services/skill_auto_update.rs"),
            include_str!("../mode/controller.rs"),
        ] {
            for (index, _) in source.match_indices(".emit(") {
                let tail = &source[index + ".emit(".len()..];
                let Some(open) = tail.find('"') else { continue };
                // Only treat a literal on the same logical argument position as
                // an event name; skip `emit(CONST, ..)` forms.
                if tail[..open].contains(')') {
                    continue;
                }
                let rest = &tail[open + 1..];
                let Some(close) = rest.find('"') else {
                    continue;
                };
                let name = &rest[..close];
                if !BRIDGED_EVENTS.contains(&name) {
                    missing.push(name.to_string());
                }
            }
        }
        missing.sort_unstable();
        missing.dedup();
        assert!(
            missing.is_empty(),
            "emitted but not bridged to browser mode: {missing:?}"
        );
    }
}
