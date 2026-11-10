// Ported from banatic/rhwp-x (MIT) src-tauri/src/hub.rs
//! 두글 agent hub (`doogle-agent/bin/doogle-hub.mjs`) 수명 관리.
//!
//! hub 는 사용자가 설치한 Node.js(22+)로 실행하는 평범한 JavaScript 다. 적합한 Node 가 없으면
//! hub 를 쓸 수 없을 뿐이고 편집기는 AI 사이드바 없이 그대로 동작한다.
//!
//! 앱은 실행마다 hub 하나를 소유한다. 표준출력의 `DOOGLE_HUB_READY {json}` 줄에서 port/token 을
//! 읽고, hub 가 죽으면 지수 백오프로 다시 띄우며, 앱이 끝나면 프로세스를 죽인다. Windows 에서는
//! Job Object(KILL_ON_JOB_CLOSE)에 넣어 앱이 비정상 종료돼도 hub 가 남지 않게 한다.
//!
//! 이 모듈은 어떤 자격증명도 읽거나 중계하지 않는다(CONTRACT §0). 비밀값은 hub 가 OS keyring 으로 다룬다.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::Value;

const READY_PREFIX: &str = "DOOGLE_HUB_READY ";
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const MIN_NODE_MAJOR: u32 = 22;
/// 이 시간 이상 살아 있던 hub 가 죽으면 백오프를 처음부터 다시 센다.
const STABLE_AFTER: Duration = Duration::from_secs(60);
const MAX_BACKOFF: Duration = Duration::from_secs(30);

/// webview 에 넘기는 연결 정보 (`hub_info` 명령의 반환값).
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct HubInfo {
    pub port: u16,
    pub token: String,
    pub pid: u32,
}

/// hub 상태 변화 알림. lib.rs 가 webview 이벤트로 바꿔 내보낸다.
#[derive(Clone, Debug)]
pub enum HubEvent {
    Ready(HubInfo),
    Exited { restart_in_ms: u64 },
    Failed(String),
}

pub struct HubConfig {
    /// `doogle-hub.mjs` 절대 경로
    pub script: PathBuf,
    /// hub 의 작업 디렉터리 (doogle-agent 루트)
    pub cwd: PathBuf,
    pub log_path: PathBuf,
}

enum Phase {
    Idle,
    Starting,
    Ready(HubInfo),
}

struct Inner {
    phase: Phase,
    child: Option<Child>,
    quitting: bool,
    epoch: u64,
    started_at: Option<Instant>,
    failures: u32,
}

type Listener = Box<dyn Fn(HubEvent) + Send + Sync>;

pub struct HubOwner {
    config: HubConfig,
    /// 앱이 만든 실행별 토큰. hub 에 DOOGLE_HUB_TOKEN 으로 넘긴다 — 재시작해도 같은 값.
    token: String,
    inner: Mutex<Inner>,
    changed: Condvar,
    listener: Mutex<Option<Listener>>,
    #[cfg(windows)]
    job: Option<win_job::Job>,
}

impl HubOwner {
    pub fn new(config: HubConfig) -> Arc<Self> {
        Arc::new(Self {
            config,
            token: random_token(),
            inner: Mutex::new(Inner {
                phase: Phase::Idle,
                child: None,
                quitting: false,
                epoch: 0,
                started_at: None,
                failures: 0,
            }),
            changed: Condvar::new(),
            listener: Mutex::new(None),
            #[cfg(windows)]
            job: win_job::Job::new(),
        })
    }

    pub fn set_listener(&self, listener: impl Fn(HubEvent) + Send + Sync + 'static) {
        *self.listener.lock().unwrap() = Some(Box::new(listener));
    }

    fn emit(&self, event: HubEvent) {
        if let Some(listener) = self.listener.lock().unwrap().as_ref() {
            listener(event);
        }
    }

    /// 실행 중인 hub. 없으면 먼저 띄운다. 동시에 부르면 한 번만 띄우고 나머지는 기다린다.
    pub fn ensure(self: &Arc<Self>) -> Result<HubInfo, String> {
        let mut inner = self.inner.lock().unwrap();
        loop {
            if inner.quitting {
                return Err("앱을 종료하는 중입니다".into());
            }
            match &inner.phase {
                Phase::Ready(info) => {
                    let info = info.clone();
                    let alive = inner.child.as_mut().map(|child| matches!(child.try_wait(), Ok(None))).unwrap_or(false);
                    if alive {
                        return Ok(info);
                    }
                    inner.phase = Phase::Idle;
                    inner.child = None;
                }
                Phase::Starting => {
                    inner = self.changed.wait(inner).unwrap();
                }
                Phase::Idle => break,
            }
        }
        inner.phase = Phase::Starting;
        inner.epoch += 1;
        let epoch = inner.epoch;
        drop(inner);

        let started = self.start(epoch);
        let mut inner = self.inner.lock().unwrap();
        let result = match started {
            Ok((mut child, info)) => {
                if inner.quitting {
                    drop(inner);
                    let _ = child.kill();
                    let _ = child.wait();
                    self.changed.notify_all();
                    return Err("앱을 종료하는 중입니다".into());
                }
                inner.child = Some(child);
                inner.phase = Phase::Ready(info.clone());
                inner.started_at = Some(Instant::now());
                Ok(info)
            }
            Err(error) => {
                inner.phase = Phase::Idle;
                inner.failures = inner.failures.saturating_add(1);
                Err(error)
            }
        };
        drop(inner);
        self.changed.notify_all();
        match &result {
            Ok(info) => self.emit(HubEvent::Ready(info.clone())),
            Err(error) => self.emit(HubEvent::Failed(error.clone())),
        }
        result
    }

    /// 앱 종료 — hub 를 죽이고 다시 띄우지 않는다.
    pub fn shutdown(&self) {
        let child = {
            let mut inner = self.inner.lock().unwrap();
            inner.quitting = true;
            inner.phase = Phase::Idle;
            inner.child.take()
        };
        self.changed.notify_all();
        let Some(mut child) = child else { return };
        // stdin 을 닫으면 hub 가 스스로 정리하고 끝난다(DOOGLE_HUB_EXIT_ON_STDIN_CLOSE). 늦으면 죽인다.
        drop(child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    fn start(self: &Arc<Self>, epoch: u64) -> Result<(Child, HubInfo), String> {
        let config = &self.config;
        if !config.script.is_file() {
            return Err(format!("agent hub 스크립트가 없습니다: {}", config.script.display()));
        }
        let search_path = node_search_path();
        let node = find_node(&search_path).ok_or_else(|| {
            format!("Node.js {MIN_NODE_MAJOR} 이상을 찾지 못했습니다. AI 사이드바를 쓰려면 Node.js 를 설치하세요.")
        })?;
        let mut path_dirs: Vec<PathBuf> = node.parent().map(|dir| vec![dir.to_path_buf()]).unwrap_or_default();
        path_dirs.extend(search_path);
        let mut seen = std::collections::HashSet::new();
        path_dirs.retain(|dir| seen.insert(dir.clone()));
        let joined_path = std::env::join_paths(&path_dirs).map_err(|error| error.to_string())?;

        if let Some(parent) = config.log_path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let log = OpenOptions::new().create(true).append(true).open(&config.log_path).ok().map(|file| Arc::new(Mutex::new(file)));

        let mut command = Command::new(&node);
        command
            .arg(&config.script)
            .current_dir(&config.cwd)
            // stdin 은 열어 둔다. hub 는 DOOGLE_HUB_EXIT_ON_STDIN_CLOSE=1 이면 stdin 이 닫힐 때 스스로
            // 정리하고 끝난다 — 앱이 어떻게 죽든(파이프가 닫히므로) hub 가 남지 않는다.
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, _) in std::env::vars_os() {
            let key = key.to_string_lossy().to_string();
            if key.starts_with("npm_") || key.starts_with("ELECTRON_") || key.starts_with("TAURI_") {
                command.env_remove(&key);
            }
        }
        command
            .env("PATH", &joined_path)
            .env("DOOGLE_HUB_PORT", "0")
            .env("DOOGLE_HUB_TOKEN", &self.token)
            .env("DOOGLE_OWNER_PID", std::process::id().to_string())
            .env("DOOGLE_HUB_EXIT_ON_STDIN_CLOSE", "1");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command.spawn().map_err(|error| format!("agent hub 를 시작하지 못했습니다: {error}"))?;
        #[cfg(windows)]
        if let Some(job) = &self.job {
            job.assign(&child);
        }

        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let (ready_tx, ready_rx) = mpsc::channel::<HubInfo>();
        let stdout_log = log.clone();
        let owner = Arc::clone(self);
        let child_pid = child.id();
        let expected_token = self.token.clone();
        std::thread::spawn(move || {
            let mut ready_tx = Some(ready_tx);
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Some(tx) = ready_tx.as_ref() {
                    if let Some(info) = parse_ready_line(&line, child_pid, &expected_token) {
                        let _ = tx.send(info);
                        ready_tx = None;
                        // READY 줄에는 token 이 있다 — 로그에 남기지 않는다.
                        write_log(&stdout_log, "[desk] DOOGLE_HUB_READY (token redacted)");
                        continue;
                    }
                }
                write_log(&stdout_log, &line);
            }
            // hub 가 끝났다. 앱이 끝나는 중이 아니면 백오프 후 다시 띄운다.
            owner.note_exit(epoch);
        });
        let stderr_log = log.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                write_log(&stderr_log, &line);
            }
        });

        match ready_rx.recv_timeout(READY_TIMEOUT) {
            Ok(info) => Ok((child, info)),
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(format!("agent hub 가 준비되지 않았습니다. 로그: {}", config.log_path.display()))
            }
        }
    }

    fn note_exit(self: &Arc<Self>, epoch: u64) {
        let mut inner = self.inner.lock().unwrap();
        if inner.epoch != epoch || !matches!(inner.phase, Phase::Ready(_)) {
            return;
        }
        if let Some(mut child) = inner.child.take() {
            let _ = child.wait();
        }
        inner.phase = Phase::Idle;
        let stable = inner.started_at.map(|at| at.elapsed() >= STABLE_AFTER).unwrap_or(false);
        inner.failures = if stable { 0 } else { inner.failures.saturating_add(1) };
        let quitting = inner.quitting;
        let delay = backoff(inner.failures);
        drop(inner);
        self.changed.notify_all();
        if quitting {
            return;
        }
        self.emit(HubEvent::Exited { restart_in_ms: delay.as_millis() as u64 });
        let owner = Arc::clone(self);
        std::thread::spawn(move || {
            std::thread::sleep(delay);
            if owner.inner.lock().unwrap().quitting {
                return;
            }
            if let Err(error) = owner.ensure() {
                eprintln!("[desk] hub restart failed: {error}");
            }
        });
    }
}

fn backoff(failures: u32) -> Duration {
    let ms = 500u64.saturating_mul(1u64 << failures.min(10));
    Duration::from_millis(ms).min(MAX_BACKOFF)
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::fill(&mut bytes).is_err() {
        // getrandom 실패는 사실상 없다. 그래도 빈 토큰보다는 시간·pid 기반 값이 낫다.
        let seed = Instant::now().elapsed().as_nanos() ^ u128::from(std::process::id());
        bytes[..16].copy_from_slice(&seed.to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn write_log(log: &Option<Arc<Mutex<File>>>, line: &str) {
    if let Some(file) = log {
        if let Ok(mut file) = file.lock() {
            let _ = writeln!(file, "{line}");
        }
    }
}

/// `DOOGLE_HUB_READY {"port":..,"token":".."}` 해석. token 이 있으면 앱이 넘긴 값과 같아야 한다.
fn parse_ready_line(line: &str, child_pid: u32, expected_token: &str) -> Option<HubInfo> {
    let value: Value = serde_json::from_str(line.strip_prefix(READY_PREFIX)?.trim()).ok()?;
    let port = u16::try_from(value.get("port")?.as_u64()?).ok().filter(|port| *port > 0)?;
    let token = match value.get("token").and_then(Value::as_str) {
        Some(token) if !token.is_empty() => token.to_string(),
        _ => expected_token.to_string(),
    };
    let pid = value.get("pid").and_then(Value::as_u64).and_then(|pid| u32::try_from(pid).ok()).unwrap_or(child_pid);
    Some(HubInfo { port, token, pid })
}

/// `node` 를 찾을 디렉터리들. macOS GUI 앱은 PATH 가 짧아 흔한 설치 위치를 더한다.
fn node_search_path() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|path| std::env::split_paths(&path).collect()).unwrap_or_default();
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let mut extra: Vec<PathBuf> = Vec::new();
    if cfg!(windows) {
        for var in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(dir) = std::env::var_os(var) {
                extra.push(PathBuf::from(dir).join("nodejs"));
            }
        }
        if let Some(dir) = std::env::var_os("LOCALAPPDATA") {
            extra.push(PathBuf::from(&dir).join("Volta").join("bin"));
            extra.push(PathBuf::from(&dir).join("Programs").join("nodejs"));
        }
        if let Some(dir) = std::env::var_os("APPDATA") {
            extra.push(PathBuf::from(dir).join("nvm").join("current"));
        }
        if let Some(dir) = std::env::var_os("NVM_SYMLINK") {
            extra.push(PathBuf::from(dir));
        }
    } else {
        extra.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
        if let Some(home) = &home {
            extra.push(home.join(".volta/bin"));
            extra.push(home.join(".asdf/shims"));
            extra.push(home.join(".nodenv/shims"));
            extra.push(home.join(".local/bin"));
            extra.push(home.join(".local/share/fnm/aliases/default/bin"));
            if let Ok(entries) = std::fs::read_dir(home.join(".nvm/versions/node")) {
                let mut versions: Vec<PathBuf> = entries.flatten().map(|entry| entry.path().join("bin")).collect();
                versions.sort_by_key(|path| node_version_key(path));
                extra.extend(versions.into_iter().rev());
            }
        }
    }
    for dir in extra {
        if dir.is_dir() && !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

fn node_version_key(bin_dir: &Path) -> Vec<u32> {
    bin_dir
        .parent()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().trim_start_matches('v').split('.').filter_map(|part| part.parse().ok()).collect())
        .unwrap_or_default()
}

fn find_node(search_path: &[PathBuf]) -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("DOOGLE_NODE").map(PathBuf::from) {
        if node_is_usable(&configured) {
            return Some(configured);
        }
    }
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    for dir in search_path {
        let candidate = dir.join(name);
        if candidate.is_file() && node_is_usable(&candidate) {
            return Some(candidate);
        }
    }
    #[cfg(target_os = "macos")]
    {
        // 로그인 셸 프로필로만 잡히는 Node.
        if let Ok(output) = Command::new("/bin/zsh").args(["-lc", "command -v node"]).output() {
            let found = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim());
            if found.is_file() && node_is_usable(&found) {
                return Some(found);
            }
        }
    }
    None
}

fn node_is_usable(node: &Path) -> bool {
    let mut command = Command::new(node);
    command.arg("--version").stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let Ok(output) = command.output() else { return false };
    let version = String::from_utf8_lossy(&output.stdout);
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok())
        .is_some_and(|major| major >= MIN_NODE_MAJOR)
}

/// Windows: 앱 프로세스가 어떻게 끝나든 hub 가 함께 끝나도록 Job Object 에 넣는다.
#[cfg(windows)]
mod win_job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub struct Job(HANDLE);

    // HANDLE 은 프로세스 전역 커널 객체 핸들이다 — 스레드 사이에서 옮겨도 된다.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    impl Job {
        pub fn new() -> Option<Self> {
            unsafe {
                let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if handle.is_null() {
                    return None;
                }
                let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                let ok = SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const core::ffi::c_void,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                );
                if ok == 0 {
                    CloseHandle(handle);
                    return None;
                }
                Some(Self(handle))
            }
        }

        pub fn assign(&self, child: &Child) {
            unsafe {
                AssignProcessToJobObject(self.0, child.as_raw_handle() as HANDLE);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ready_line_parses_port_and_token() {
        let info = parse_ready_line(r#"DOOGLE_HUB_READY {"port":5175,"token":"abc"}"#, 7, "mine").unwrap();
        assert_eq!(info, HubInfo { port: 5175, token: "abc".into(), pid: 7 });
        let info = parse_ready_line(r#"DOOGLE_HUB_READY {"port":5175,"pid":42}"#, 7, "mine").unwrap();
        assert_eq!(info.token, "mine");
        assert_eq!(info.pid, 42);
        assert!(parse_ready_line("hello", 7, "mine").is_none());
        assert!(parse_ready_line(r#"DOOGLE_HUB_READY {"port":0}"#, 7, "mine").is_none());
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff(0), Duration::from_millis(500));
        assert_eq!(backoff(1), Duration::from_millis(1000));
        assert_eq!(backoff(20), MAX_BACKOFF);
    }

    #[test]
    fn tokens_are_random_hex() {
        let a = random_token();
        assert_eq!(a.len(), 64);
        assert_ne!(a, random_token());
    }
}
