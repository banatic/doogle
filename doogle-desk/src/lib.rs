//! 두글 데스크탑 셸 (Tauri 2).
//!
//! webview = rhwp-studio. 셸이 하는 일은 넷뿐이다.
//!  1. agent hub(Node sidecar) 를 띄우고 `hub_info` 로 port/token 을 webview 에 준다 (hub.rs).
//!  2. 네이티브 열기/저장 대화상자와 문서 파일 읽기·쓰기 (files.rs).
//!  3. 파일 연결(.hwp/.hwpx) 로 들어온 경로를 webview 에 넘긴다.
//!  4. 창 닫기 요청을 webview 의 저장 안 한 문서 확인으로 돌리고, 자동 업데이트를 맡는다 (updater.rs).
//!
//! 비밀값·자격증명은 다루지 않는다 — hub 가 OS keyring 으로 관리한다(CONTRACT §0, §5).

mod files;
mod hub;
mod updater;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::json;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, Window, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use hub::{HubConfig, HubEvent, HubInfo, HubOwner};

type CmdResult<T> = Result<T, String>;

const EVENT_HUB: &str = "doogle://hub";
const EVENT_OPEN: &str = "doogle://open-request";
const EVENT_CLOSE_REQUESTED: &str = "doogle://close-requested";
const SAVE_PATH_HEADER: &str = "x-doogle-path";

struct Shell {
    hub: Arc<HubOwner>,
    /// 아직 webview 가 가져가지 않은 열기 요청(파일 연결·두 번째 실행·macOS Opened).
    pending_opens: Mutex<Vec<PathBuf>>,
    /// webview 가 닫기 확인(저장 안 한 문서)을 맡겠다고 알렸는가. 아니면 닫기를 막지 않는다 —
    /// webview 가 아직 안 떴거나 죽었을 때 창을 못 닫는 일을 피한다.
    close_guard: AtomicBool,
}

async fn blocking<T: Send + 'static>(work: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|error| error.to_string())?
}

// ----------------------------------------------------------------- hub

/// hub 연결 정보. hub 가 없으면 띄우고 준비될 때까지 기다린다.
#[tauri::command]
async fn hub_info(state: State<'_, Arc<Shell>>) -> CmdResult<HubInfo> {
    let hub = Arc::clone(&state.hub);
    blocking(move || hub.ensure()).await
}

// ----------------------------------------------------------------- files

#[tauri::command]
async fn open_file(path: String) -> CmdResult<Response> {
    blocking(move || files::read_document(&path).map(Response::new)).await
}

#[derive(Deserialize)]
struct SaveJson {
    path: String,
    bytes: Vec<u8>,
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 문서 저장. 두 형태를 받는다.
///  - 원본 바이트 본문 + `x-doogle-path` 헤더(percent-encoded 경로) — 큰 문서용
///  - JSON `{path, bytes:number[]}`
#[tauri::command]
async fn save_file(request: Request<'_>) -> CmdResult<()> {
    let (path, bytes) = match request.body() {
        InvokeBody::Raw(bytes) => {
            let header = request
                .headers()
                .get(SAVE_PATH_HEADER)
                .and_then(|value| value.to_str().ok())
                .and_then(percent_decode)
                .ok_or("저장 경로가 없습니다")?;
            (header, bytes.clone())
        }
        InvokeBody::Json(value) => {
            let parsed: SaveJson = serde_json::from_value(value.clone()).map_err(|error| format!("잘못된 저장 요청: {error}"))?;
            (parsed.path, parsed.bytes)
        }
    };
    blocking(move || files::write_document(&path, &bytes)).await
}

#[tauri::command]
async fn pick_open_file(window: WebviewWindow, app: AppHandle) -> CmdResult<Option<String>> {
    blocking(move || {
        let picked = app
            .dialog()
            .file()
            .set_parent(&window)
            .add_filter("한글 문서", &files::OPEN_EXTENSIONS)
            .blocking_pick_file();
        let Some(picked) = picked else { return Ok(None) };
        let path = picked.into_path().map_err(|error| error.to_string())?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
}

#[tauri::command]
async fn pick_save_file(window: WebviewWindow, app: AppHandle, suggested_name: Option<String>) -> CmdResult<Option<String>> {
    blocking(move || {
        let mut dialog = app.dialog().file().set_parent(&window).add_filter("한글 문서", &files::SUPPORTED_EXTENSIONS);
        if let Some(name) = suggested_name.filter(|name| !name.trim().is_empty()) {
            dialog = dialog.set_file_name(name);
        }
        let Some(picked) = dialog.blocking_save_file() else { return Ok(None) };
        let mut path = picked.into_path().map_err(|error| error.to_string())?;
        if !files::SUPPORTED_EXTENSIONS.contains(&files::extension_of(&path).as_str()) {
            path.set_extension("hwpx");
        }
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
}

/// 파일 탐색기에서 문서 위치를 연다(제목 막대 '폴더에서 보기').
#[tauri::command]
async fn reveal_in_folder(path: String) -> CmdResult<()> {
    blocking(move || files::reveal_in_folder(&path)).await
}

/// 최근 문서 카드의 파일 정보(있는지·수정 시각).
#[tauri::command]
async fn file_stat(path: String) -> CmdResult<files::FileStat> {
    blocking(move || files::file_stat(&path)).await
}

/// 백스테이지 '새로 만들기' 템플릿 — 리소스 `templates/*.hwpx`.
#[tauri::command]
async fn list_templates(app: AppHandle) -> CmdResult<Vec<files::TemplateInfo>> {
    let dir = app.path().resource_dir().map(|dir| dir.join("templates")).map_err(|error| error.to_string())?;
    blocking(move || Ok(files::list_templates(&dir))).await
}

/// 로그인 페이지 등 외부 주소를 시스템 브라우저로 연다. https 만 허용한다
/// (loopback 콜백 주소 `http://127.0.0.1:*` 도 허용 — SIWC PKCE 흐름).
#[tauri::command]
fn open_external(app: AppHandle, url: String) -> CmdResult<()> {
    let allowed = url.starts_with("https://") || url.starts_with("http://127.0.0.1:");
    if !allowed {
        return Err("https 주소만 열 수 있습니다".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|error| error.to_string())
}

/// 아직 처리하지 않은 열기 요청을 가져간다. webview 는 시작 시와 `doogle://open-request` 때 부른다.
#[tauri::command]
fn take_open_requests(state: State<'_, Arc<Shell>>) -> Vec<String> {
    std::mem::take(&mut *state.pending_opens.lock().unwrap())
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect()
}

fn queue_opens(app: &AppHandle, paths: Vec<PathBuf>) {
    if paths.is_empty() {
        return;
    }
    if let Some(shell) = app.try_state::<Arc<Shell>>() {
        shell.pending_opens.lock().unwrap().extend(paths);
    }
    let _ = app.emit(EVENT_OPEN, ());
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// ----------------------------------------------------------------- close guard

/// webview 가 `doogle://close-requested` 를 듣기 시작했다(또는 그만뒀다).
#[tauri::command]
fn set_close_guard(state: State<'_, Arc<Shell>>, enabled: bool) {
    state.close_guard.store(enabled, Ordering::SeqCst);
}

/// webview 가 확인을 마쳤으니 창을 정말 닫는다. destroy 는 CloseRequested 를 다시 거치지 않는다.
#[tauri::command]
fn confirm_close(window: WebviewWindow) -> CmdResult<()> {
    window.destroy().map_err(|error| error.to_string())
}

fn on_window_event(window: &Window, event: &WindowEvent) {
    let WindowEvent::CloseRequested { api, .. } = event else { return };
    if window.label() != "main" {
        return;
    }
    let guarded = window
        .app_handle()
        .try_state::<Arc<Shell>>()
        .is_some_and(|shell| shell.close_guard.load(Ordering::SeqCst));
    if guarded {
        api.prevent_close();
        let _ = window.emit_to(window.label(), EVENT_CLOSE_REQUESTED, ());
    }
}

// ----------------------------------------------------------------- setup

/// hub 가 있는 doogle-agent 디렉터리. 개발 빌드는 저장소의 것을, 배포본은 리소스를 쓴다.
fn agent_dir(app: &AppHandle) -> PathBuf {
    if let Some(dir) = std::env::var_os("DOOGLE_AGENT_DIR").map(PathBuf::from) {
        return dir;
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("doogle-agent");
    if cfg!(debug_assertions) && development.join("bin").join("doogle-hub.mjs").is_file() {
        return development.canonicalize().map(strip_verbatim).unwrap_or(development);
    }
    app.path().resource_dir().map(|dir| dir.join("doogle-agent")).unwrap_or(development)
}

/// Windows `canonicalize` 의 `\\?\` 접두어는 Node 가 싫어한다.
fn strip_verbatim(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with("UNC") => PathBuf::from(rest),
        _ => path,
    }
}

fn hub_event_payload(event: &HubEvent) -> serde_json::Value {
    match event {
        HubEvent::Ready(info) => json!({ "state": "ready", "port": info.port, "token": info.token, "pid": info.pid }),
        HubEvent::Exited { restart_in_ms } => json!({ "state": "exited", "restartInMs": restart_in_ms }),
        HubEvent::Failed(message) => json!({ "state": "failed", "message": message }),
    }
}

/// hub 표준 출력·오류가 쌓이는 로그 파일(hub.rs 가 줄마다 덧붙인다).
fn hub_log_path(app: &AppHandle) -> PathBuf {
    app.path().app_log_dir().unwrap_or_else(|_| std::env::temp_dir().join("doogle")).join("hub.log")
}

/// 에이전트 서비스 로그를 OS 기본 프로그램으로 연다. 파일이 없으면 만든다. 연 경로를 돌려준다.
#[tauri::command]
async fn open_hub_log(app: AppHandle) -> CmdResult<String> {
    let path = hub_log_path(&app);
    let opened = path.clone();
    blocking(move || {
        if let Some(parent) = opened.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("로그 폴더를 만들 수 없습니다: {error}"))?;
        }
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&opened)
            .map_err(|error| format!("로그 파일을 열 수 없습니다: {error}"))?;
        app.opener()
            .open_path(opened.to_string_lossy().to_string(), None::<&str>)
            .map_err(|error| format!("로그를 열 수 없습니다: {error}"))
    })
    .await?;
    Ok(path.to_string_lossy().to_string())
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let dir = agent_dir(&handle);
    let log_path = hub_log_path(&handle);
    let hub = HubOwner::new(HubConfig { script: dir.join("bin").join("doogle-hub.mjs"), cwd: dir, log_path });
    let emitter = handle.clone();
    hub.set_listener(move |event| {
        let _ = emitter.emit(EVENT_HUB, hub_event_payload(&event));
    });
    let args: Vec<String> = std::env::args().skip(1).collect();
    let shell = Arc::new(Shell {
        hub: Arc::clone(&hub),
        pending_opens: Mutex::new(files::document_paths_from_args(&args, None)),
        close_guard: AtomicBool::new(false),
    });
    app.manage(shell);
    app.manage(updater::PendingUpdate::default());
    // 사이드바가 열리기 전에 미리 띄워 첫 질문의 대기 시간을 줄인다. 실패해도 앱은 계속 쓴다.
    std::thread::spawn(move || {
        if let Err(error) = hub.ensure() {
            eprintln!("[desk] agent hub unavailable: {error}");
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            let paths = files::document_paths_from_args(&argv.into_iter().skip(1).collect::<Vec<_>>(), Some(Path::new(&cwd)));
            queue_opens(app, paths);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(on_window_event)
        .invoke_handler(tauri::generate_handler![
            hub_info,
            open_file,
            save_file,
            pick_open_file,
            pick_save_file,
            take_open_requests,
            open_external,
            reveal_in_folder,
            file_stat,
            list_templates,
            open_hub_log,
            set_close_guard,
            confirm_close,
            updater::update_check,
            updater::update_install,
        ])
        .setup(setup)
        .build(tauri::generate_context!())
        .expect("error while building 두글");

    app.run(|app, event| match event {
        RunEvent::Exit => {
            if let Some(shell) = app.try_state::<Arc<Shell>>() {
                shell.hub.shutdown();
            }
        }
        #[cfg(any(target_os = "macos", target_os = "ios"))]
        RunEvent::Opened { urls } => {
            let paths = urls.into_iter().filter_map(|url| url.to_file_path().ok()).collect();
            queue_opens(app, paths);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_decoding_handles_korean_paths() {
        assert_eq!(percent_decode("C%3A%5C%EB%AC%B8%EC%84%9C.hwp").as_deref(), Some("C:\\문서.hwp"));
        assert!(percent_decode("%ZZ").is_none());
    }

    #[test]
    fn verbatim_prefix_is_stripped() {
        assert_eq!(strip_verbatim(PathBuf::from(r"\\?\C:\a")), PathBuf::from(r"C:\a"));
    }
}
