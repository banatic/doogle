//! 문서 파일 읽기·쓰기. webview 가 임의 파일을 읽지 못하도록 한글 문서 확장자만 허용한다.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub const SUPPORTED_EXTENSIONS: [&str; 2] = ["hwp", "hwpx"];
/// 열기 대화상자에는 studio 가 여는 HWPML 도 함께 보인다.
pub const OPEN_EXTENSIONS: [&str; 3] = ["hwp", "hwpx", "hml"];
const MAX_DOCUMENT_BYTES: u64 = 512 * 1024 * 1024;

pub fn extension_of(path: &Path) -> String {
    path.extension().map(|ext| ext.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
}

fn checked_path(path: &str, allowed: &[&str]) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    if !path.is_absolute() {
        return Err("절대 경로가 필요합니다".into());
    }
    let ext = extension_of(&path);
    if !allowed.contains(&ext.as_str()) {
        return Err(format!("지원하지 않는 파일 형식입니다: .{ext}"));
    }
    Ok(path)
}

pub fn read_document(path: &str) -> Result<Vec<u8>, String> {
    let path = checked_path(path, &OPEN_EXTENSIONS)?;
    let meta = fs::metadata(&path).map_err(|error| format!("파일을 열 수 없습니다: {error}"))?;
    if !meta.is_file() {
        return Err("파일이 아닙니다".into());
    }
    if meta.len() > MAX_DOCUMENT_BYTES {
        return Err("파일이 너무 큽니다".into());
    }
    fs::read(&path).map_err(|error| format!("파일을 읽을 수 없습니다: {error}"))
}

/// 같은 폴더의 임시 파일에 쓴 뒤 이름을 바꿔, 저장 중 오류가 원본을 깨뜨리지 않게 한다.
pub fn write_document(path: &str, bytes: &[u8]) -> Result<(), String> {
    let path = checked_path(path, &SUPPORTED_EXTENSIONS)?;
    let parent = path.parent().ok_or("저장할 폴더가 없습니다")?;
    if !parent.is_dir() {
        return Err("저장할 폴더가 없습니다".into());
    }
    let name = path.file_name().map(|name| name.to_string_lossy().to_string()).unwrap_or_default();
    let temp = parent.join(format!(".{name}.doogle-{}.tmp", std::process::id()));
    let result = (|| {
        let mut file = fs::File::create(&temp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, &path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(format!("저장하지 못했습니다: {error}"));
    }
    Ok(())
}

/// 파일 탐색기에서 문서를 선택한 채로 폴더를 연다. 한글 문서 경로만 받는다.
pub fn reveal_in_folder(path: &str) -> Result<(), String> {
    let path = checked_path(path, &OPEN_EXTENSIONS)?;
    if !path.exists() {
        return Err("파일을 찾을 수 없습니다".into());
    }
    #[cfg(target_os = "windows")]
    let status = {
        use std::os::windows::process::CommandExt;
        // explorer 는 `/select,<경로>` 를 한 인자로 받는다(따옴표를 직접 붙이지 않는다).
        std::process::Command::new("explorer").raw_arg(format!("/select,\"{}\"", path.display())).spawn()
    };
    #[cfg(target_os = "macos")]
    let status = std::process::Command::new("open").arg("-R").arg(&path).spawn();
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let status = std::process::Command::new("xdg-open").arg(path.parent().ok_or("폴더가 없습니다")?).spawn();
    status.map(|_| ()).map_err(|error| format!("폴더를 열 수 없습니다: {error}"))
}

/// 최근 문서 카드용 파일 정보. 없는 파일은 `exists: false`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
    pub exists: bool,
    pub size: Option<u64>,
    pub modified_ms: Option<u64>,
}

pub fn file_stat(path: &str) -> Result<FileStat, String> {
    let path = checked_path(path, &OPEN_EXTENSIONS)?;
    let Ok(meta) = fs::metadata(&path) else {
        return Ok(FileStat { exists: false, size: None, modified_ms: None });
    };
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64);
    Ok(FileStat { exists: meta.is_file(), size: Some(meta.len()), modified_ms })
}

/// 새로 만들기 템플릿 — `<dir>/*.hwpx` 를 이름순으로. 폴더가 없으면 빈 목록.
#[derive(serde::Serialize)]
pub struct TemplateInfo {
    pub name: String,
    pub path: String,
}

pub fn list_templates(dir: &Path) -> Vec<TemplateInfo> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<TemplateInfo> = entries
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && extension_of(path) == "hwpx")
        .map(|path| TemplateInfo {
            name: path.file_stem().map(|stem| stem.to_string_lossy().to_string()).unwrap_or_default(),
            path: path.to_string_lossy().to_string(),
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/// 명령줄 인자 중 문서 경로.
pub fn document_paths_from_args(args: &[String], cwd: Option<&Path>) -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();
    for arg in args {
        if arg.starts_with('-') {
            continue;
        }
        let candidate = PathBuf::from(arg.trim_matches('"'));
        if !OPEN_EXTENSIONS.contains(&extension_of(&candidate).as_str()) {
            continue;
        }
        let absolute = if candidate.is_absolute() {
            candidate
        } else {
            cwd.map(Path::to_path_buf).or_else(|| std::env::current_dir().ok()).unwrap_or_default().join(candidate)
        };
        if !paths.contains(&absolute) {
            paths.push(absolute);
        }
    }
    paths
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_documents_are_accepted() {
        assert!(read_document("relative.hwp").is_err());
        let abs = std::env::temp_dir().join("x.txt");
        assert!(read_document(&abs.to_string_lossy()).unwrap_err().contains(".txt"));
    }

    #[test]
    fn args_pick_documents() {
        let cwd = std::env::temp_dir();
        let args = vec!["--flag".to_string(), "a.hwp".into(), "b.txt".into(), "a.hwp".into()];
        let paths = document_paths_from_args(&args, Some(&cwd));
        assert_eq!(paths, vec![cwd.join("a.hwp")]);
    }

    #[test]
    fn stat_and_templates() {
        let dir = std::env::temp_dir().join(format!("doogle-tpl-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let file = dir.join("공문.hwpx");
        fs::write(&file, b"PK").unwrap();
        fs::write(dir.join("note.txt"), b"x").unwrap();
        let list = list_templates(&dir);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "공문");
        let st = file_stat(&file.to_string_lossy()).unwrap();
        assert!(st.exists && st.size == Some(2));
        assert!(!file_stat(&dir.join("없음.hwp").to_string_lossy()).unwrap().exists);
        assert!(file_stat(&dir.join("note.txt").to_string_lossy()).is_err());
        assert!(list_templates(&dir.join("missing")).is_empty());
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn write_then_read_roundtrip() {
        let path = std::env::temp_dir().join(format!("doogle-test-{}.hwpx", std::process::id()));
        let text = path.to_string_lossy().to_string();
        write_document(&text, b"PK").unwrap();
        assert_eq!(read_document(&text).unwrap(), b"PK");
        let _ = fs::remove_file(path);
    }
}
