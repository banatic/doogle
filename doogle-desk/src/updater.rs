//! 자동 업데이트 (tauri-plugin-updater).
//!
//! webview 는 플러그인 IPC(`plugin:updater|*`, resource id + Channel) 대신 이 두 명령만 쓴다.
//!  - `update_check`   : 새 버전이 있으면 메타데이터를 돌려주고 `Update` 를 상태에 보관한다.
//!  - `update_install` : 보관한 `Update` 를 내려받아(`doogle://update-progress` 이벤트) 설치하고 재시작한다.
//!
//! 저장 안 한 문서 확인은 webview 가 `update_install` 을 부르기 전에 끝낸다.
//! Windows 는 설치 단계에서 플러그인이 NSIS(passive)를 띄우고 `process::exit(0)` 한다 —
//! 설치기가 끝나면 앱을 다시 띄운다. macOS·Linux 는 설치 뒤 `restart()` 한다.

use std::sync::{Arc, Mutex};

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::Shell;

pub const EVENT_UPDATE_PROGRESS: &str = "doogle://update-progress";

#[derive(Default)]
pub struct PendingUpdate(pub Mutex<Option<Update>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    current_version: String,
    body: Option<String>,
    date: Option<String>,
}

#[tauri::command]
pub async fn update_check(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<Option<UpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    let info = update.as_ref().map(|update| UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        body: update.body.clone(),
        date: update.date.map(|date| date.to_string()),
    });
    *pending.0.lock().unwrap() = update;
    Ok(info)
}

#[tauri::command]
pub async fn update_install(app: AppHandle, pending: State<'_, PendingUpdate>) -> Result<(), String> {
    let update = pending
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or("먼저 업데이트를 확인하세요")?;

    let emitter = app.clone();
    let mut downloaded: u64 = 0;
    let bytes = update
        .download(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = emitter.emit(EVENT_UPDATE_PROGRESS, json!({ "phase": "download", "downloaded": downloaded, "total": total }));
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;
    let _ = app.emit(EVENT_UPDATE_PROGRESS, json!({ "phase": "install" }));

    // 설치기가 doogle-agent 리소스를 덮어쓸 수 있게 hub(Node) 를 먼저 내린다.
    if let Some(shell) = app.try_state::<Arc<Shell>>() {
        shell.hub.shutdown();
    }
    // Windows: 여기서 설치기를 띄우고 프로세스가 끝난다.
    update.install(bytes).map_err(|error| error.to_string())?;
    app.restart();
}
