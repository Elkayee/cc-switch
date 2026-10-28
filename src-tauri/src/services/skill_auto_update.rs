//! Daily background skill auto-update.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::database::Database;
use crate::services::skill::SkillService;
use crate::AppRuntime;

pub const DAILY_INTERVAL_SECS: i64 = 24 * 60 * 60;
const STARTUP_GRACE_SECS: u64 = 15;
const MIN_SLEEP_SECS: i64 = 60;
pub(crate) const MAX_FAILURES: usize = 20;
pub(crate) const MAX_FAILURE_CHARS: usize = 240;
const STATUS_FILE: &str = "skill-auto-update.json";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoUpdateStatus {
    pub last_run_at: Option<i64>,
    pub running: bool,
    pub updated_count: u32,
    pub failures: Vec<String>,
}

fn live_status() -> &'static Mutex<Option<AutoUpdateStatus>> {
    static LIVE: OnceLock<Mutex<Option<AutoUpdateStatus>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(None))
}

fn set_live(status: AutoUpdateStatus) {
    if let Ok(mut guard) = live_status().lock() {
        *guard = Some(status);
    }
}

pub fn is_due(last_run: Option<i64>, now: i64, interval_secs: i64) -> bool {
    match last_run {
        None => true,
        Some(ts) => now.saturating_sub(ts) >= interval_secs,
    }
}

pub fn next_sleep_secs(last_run: Option<i64>, now: i64, interval_secs: i64) -> u64 {
    match last_run {
        Some(ts) if now >= ts => interval_secs
            .saturating_sub(now.saturating_sub(ts))
            .max(MIN_SLEEP_SECS) as u64,
        _ => interval_secs.max(MIN_SLEEP_SECS) as u64,
    }
}

pub fn cap_failures(failures: Vec<String>) -> Vec<String> {
    failures
        .into_iter()
        .take(MAX_FAILURES)
        .map(|item| {
            let count = item.chars().count();
            if count <= MAX_FAILURE_CHARS {
                item
            } else {
                let mut truncated: String = item.chars().take(MAX_FAILURE_CHARS).collect();
                truncated.push('…');
                truncated
            }
        })
        .collect()
}

pub fn apply_updates_plan(
    update_ids: &[String],
    now: i64,
    mut apply: impl FnMut(&str) -> Result<(), String>,
) -> AutoUpdateStatus {
    let mut updated_count = 0;
    let mut failures = Vec::new();
    for id in update_ids {
        match apply(id) {
            Ok(()) => updated_count += 1,
            Err(error) => failures.push(format!("{id}: {error}")),
        }
    }
    AutoUpdateStatus {
        last_run_at: Some(now),
        running: false,
        updated_count,
        failures: cap_failures(failures),
    }
}

pub fn status_path(config_dir: &Path) -> PathBuf {
    config_dir.join(STATUS_FILE)
}

pub fn load_status(path: &Path) -> AutoUpdateStatus {
    let mut status: AutoUpdateStatus = std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    status.running = false;
    status.failures = cap_failures(status.failures);
    status
}

pub fn save_status(path: &Path, status: &AutoUpdateStatus) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let raw = serde_json::to_vec_pretty(status).unwrap_or_else(|_| b"{}".to_vec());
    crate::config::atomic_write(path, &raw).map_err(|err| std::io::Error::other(err.to_string()))
}

pub fn current_status() -> AutoUpdateStatus {
    if let Ok(guard) = live_status().lock() {
        if let Some(status) = guard.clone() {
            return status;
        }
    }
    load_status(&status_path(&crate::config::get_app_config_dir()))
}

fn persist_and_emit(path: &Path, status: &AutoUpdateStatus, app: &AppHandle<AppRuntime>) {
    set_live(status.clone());
    let mut disk = status.clone();
    disk.running = false;
    let _ = save_status(path, &disk);
    let _ = app.emit("skill-auto-update-status", status);
}

pub fn start_worker(db: Arc<Database>, service: Arc<SkillService>, app: AppHandle<AppRuntime>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(STARTUP_GRACE_SECS)).await;
        loop {
            let path = status_path(&crate::config::get_app_config_dir());
            let status = load_status(&path);
            let now = chrono::Utc::now().timestamp();
            if is_due(status.last_run_at, now, DAILY_INTERVAL_SECS) {
                let mut running = status.clone();
                running.running = true;
                persist_and_emit(&path, &running, &app);

                let done = match service.check_updates(&db).await {
                    Ok(updates) => {
                        let ids: Vec<String> = updates.into_iter().map(|item| item.id).collect();
                        let mut updated_count = 0_u32;
                        let mut failures = Vec::new();
                        for id in ids {
                            match service.update_skill(&db, &id).await {
                                Ok(_) => updated_count += 1,
                                Err(error) => failures.push(format!("{id}: {error}")),
                            }
                        }
                        AutoUpdateStatus {
                            last_run_at: Some(now),
                            running: false,
                            updated_count,
                            failures: cap_failures(failures),
                        }
                    }
                    Err(error) => AutoUpdateStatus {
                        last_run_at: Some(now),
                        running: false,
                        updated_count: 0,
                        failures: cap_failures(vec![error.to_string()]),
                    },
                };
                persist_and_emit(&path, &done, &app);
            }

            let status = load_status(&path);
            let now = chrono::Utc::now().timestamp();
            let sleep_secs = next_sleep_secs(status.last_run_at, now, DAILY_INTERVAL_SECS);
            tokio::time::sleep(Duration::from_secs(sleep_secs)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn due_when_never_run() {
        assert!(is_due(None, 1_000_000, DAILY_INTERVAL_SECS));
    }

    #[test]
    fn not_due_before_interval() {
        let last = 1_000_000;
        assert!(!is_due(
            Some(last),
            last + DAILY_INTERVAL_SECS - 1,
            DAILY_INTERVAL_SECS
        ));
    }

    #[test]
    fn due_when_interval_elapsed() {
        let last = 1_000_000;
        assert!(is_due(
            Some(last),
            last + DAILY_INTERVAL_SECS,
            DAILY_INTERVAL_SECS
        ));
    }

    #[test]
    fn apply_plan_counts_successes_and_failures() {
        let status = apply_updates_plan(&["ok".into(), "bad".into(), "ok2".into()], 50, |id| {
            if id == "bad" {
                Err("boom".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(status.last_run_at, Some(50));
        assert!(!status.running);
        assert_eq!(status.updated_count, 2);
        assert_eq!(status.failures, vec!["bad: boom".to_string()]);
    }

    #[test]
    fn apply_plan_with_no_updates_still_records_run() {
        let status = apply_updates_plan(&[], 9, |_| Ok(()));
        assert_eq!(status.last_run_at, Some(9));
        assert_eq!(status.updated_count, 0);
        assert!(status.failures.is_empty());
    }

    #[test]
    fn load_missing_file_is_default() {
        let path = std::env::temp_dir().join(format!(
            "skill-auto-update-missing-{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        assert_eq!(load_status(&path), AutoUpdateStatus::default());
    }

    #[test]
    fn save_then_load_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("skill-auto-update.json");
        let status = AutoUpdateStatus {
            last_run_at: Some(42),
            running: false,
            updated_count: 3,
            failures: vec!["x".into()],
        };
        save_status(&path, &status).unwrap();
        assert_eq!(load_status(&path), status);
    }

    #[test]
    fn load_clears_stale_running_flag() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("skill-auto-update.json");
        std::fs::write(
            &path,
            r#"{"lastRunAt":1,"running":true,"updatedCount":0,"failures":[]}"#,
        )
        .unwrap();
        let status = load_status(&path);
        assert!(!status.running);
        assert_eq!(status.last_run_at, Some(1));
    }

    #[test]
    fn apply_plan_caps_and_truncates_failures() {
        let ids: Vec<String> = (0..25).map(|i| format!("skill-{i}")).collect();
        let long = "e".repeat(400);
        let status = apply_updates_plan(&ids, 1, |_| Err(long.clone()));
        assert_eq!(status.failures.len(), MAX_FAILURES);
        assert!(status
            .failures
            .iter()
            .all(|item| item.chars().count() <= MAX_FAILURE_CHARS + 1));
    }

    #[test]
    fn sleep_uses_remaining_interval() {
        let last = 1_000_000;
        assert_eq!(
            next_sleep_secs(Some(last), last + 100, DAILY_INTERVAL_SECS),
            (DAILY_INTERVAL_SECS - 100) as u64
        );
    }

    #[test]
    fn sleep_falls_back_on_clock_skew() {
        assert_eq!(
            next_sleep_secs(Some(5_000), 1_000, DAILY_INTERVAL_SECS),
            DAILY_INTERVAL_SECS as u64
        );
    }

    #[test]
    fn sleep_never_shorter_than_a_minute() {
        let last = 1_000_000;
        assert_eq!(
            next_sleep_secs(
                Some(last),
                last + DAILY_INTERVAL_SECS - 10,
                DAILY_INTERVAL_SECS
            ),
            60
        );
    }
}
