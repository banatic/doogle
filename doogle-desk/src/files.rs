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
    fn write_then_read_roundtrip() {
        let path = std::env::temp_dir().join(format!("doogle-test-{}.hwpx", std::process::id()));
        let text = path.to_string_lossy().to_string();
        write_document(&text, b"PK").unwrap();
        assert_eq!(read_document(&text).unwrap(), b"PK");
        let _ = fs::remove_file(path);
    }
}
