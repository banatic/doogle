//! .hwp / .hwpx 기본 앱 설정.
//!
//! Windows 8 이후로는 앱이 스스로 기본 앱이 될 수 없다(UserChoice 는 해시로 보호된다). 그래서
//!  1. 두글을 .hwp/.hwpx 를 여는 앱으로 사용자 레지스트리(HKCU)에 등록하고 — ProgID · 열기 명령 ·
//!     OpenWithProgids · Capabilities/RegisteredApplications —
//!  2. Windows 설정의 "기본 앱 › 두글" 화면을 연다. 사용자가 거기서 두 형식을 두글로 고른다.
//! 지금 기본 앱이 무엇인지는 AssocQueryString 으로 읽어 보여 준다.
//!
//! macOS·Linux 는 여기서 바꾸지 않고 방법만 알려 준다(supported = false).

use serde::Serialize;

pub const EXTENSIONS: [&str; 2] = [".hwp", ".hwpx"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtStatus {
    pub ext: String,
    /// 지금 이 형식을 두글이 연다
    pub is_default: bool,
    /// 지금 여는 앱 이름 (모르면 None)
    pub current: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultAppStatus {
    /// 이 OS 에서 설정 화면까지 데려다줄 수 있다
    pub supported: bool,
    pub exts: Vec<ExtStatus>,
    /// 지원하지 않는 OS 에서 사용자에게 보일 방법
    pub hint: Option<String>,
}

#[cfg(windows)]
pub use win::{set_default_app, status};

#[cfg(not(windows))]
pub fn status() -> Result<DefaultAppStatus, String> {
    let hint = if cfg!(target_os = "macos") {
        "Finder에서 .hwp 파일을 선택하고 ⌘I(정보 가져오기) › 다음으로 열기에서 두글을 고른 뒤 \"모두 변경\"을 누르세요. .hwpx도 같은 방법으로 바꿉니다."
    } else {
        "파일 관리자에서 .hwp 파일을 오른쪽 클릭 › 속성 › 다음으로 열기에서 두글을 기본으로 고르세요. .hwpx도 같은 방법으로 바꿉니다."
    };
    Ok(DefaultAppStatus {
        supported: false,
        exts: EXTENSIONS.iter().map(|ext| ExtStatus { ext: ext.to_string(), is_default: false, current: None }).collect(),
        hint: Some(hint.to_string()),
    })
}

#[cfg(not(windows))]
pub fn set_default_app() -> Result<(), String> {
    Err("이 운영체제에서는 두글이 기본 앱 설정 화면을 열 수 없습니다.".into())
}

#[cfg(windows)]
mod win {
    use super::{DefaultAppStatus, ExtStatus, EXTENSIONS};
    use std::ffi::c_void;
    use std::path::Path;
    use std::ptr::{null, null_mut};

    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_WRITE, REG_OPTION_NON_VOLATILE, REG_SZ,
    };
    use windows_sys::Win32::UI::Shell::{
        AssocQueryStringW, SHChangeNotify, ShellExecuteW, ASSOCF_NONE, ASSOCSTR_EXECUTABLE, ASSOCSTR_FRIENDLYAPPNAME,
        SHCNE_ASSOCCHANGED, SHCNF_IDLIST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    /// RegisteredApplications 의 이름 — 설정 화면 주소(registeredAppUser=)에도 쓴다. ASCII 로 둔다.
    const REGISTERED_NAME: &str = "Doogle";
    const CAPABILITIES: &str = r"Software\Doogle\Capabilities";
    const APP_NAME: &str = "두글";

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn prog_id(ext: &str) -> String {
        format!("Doogle{ext}") // Doogle.hwp, Doogle.hwpx
    }

    /// 파일 형식 아이콘 — 실행 파일에 넣은 아이콘 리소스 번호(build.rs)
    fn icon_resource(ext: &str) -> u32 {
        if ext == ".hwpx" { 32514 } else { 32513 }
    }

    fn type_name(ext: &str) -> &'static str {
        if ext == ".hwpx" { "한글 문서 (HWPX)" } else { "한글 문서" }
    }

    /// HKCU\<path> 에 문자열 값을 쓴다. name 이 None 이면 (기본값).
    fn set_str(path: &str, name: Option<&str>, value: &str) -> Result<(), String> {
        let mut key: HKEY = null_mut();
        let path_w = wide(path);
        // SAFETY: 모든 포인터는 이 함수 안에서 살아 있는 버퍼를 가리킨다.
        let rc = unsafe {
            RegCreateKeyExW(HKEY_CURRENT_USER, path_w.as_ptr(), 0, null(), REG_OPTION_NON_VOLATILE, KEY_WRITE, null(), &mut key, null_mut())
        };
        if rc != 0 {
            return Err(format!("레지스트리 키를 만들지 못했습니다 ({path}, 오류 {rc})"));
        }
        let value_w = wide(value);
        let name_w = name.map(wide);
        let rc = unsafe {
            RegSetValueExW(
                key,
                name_w.as_ref().map_or(null(), |n| n.as_ptr()),
                0,
                REG_SZ,
                value_w.as_ptr() as *const u8,
                (value_w.len() * 2) as u32,
            )
        };
        unsafe { RegCloseKey(key) };
        if rc != 0 {
            return Err(format!("레지스트리 값을 쓰지 못했습니다 ({path}, 오류 {rc})"));
        }
        Ok(())
    }

    fn assoc_query(ext: &str, what: i32) -> Option<String> {
        let ext_w = wide(ext);
        let verb = wide("open");
        let mut len: u32 = 1024;
        let mut buf = vec![0u16; len as usize];
        // SAFETY: buf 는 len 개의 u16 을 담는다.
        let hr = unsafe { AssocQueryStringW(ASSOCF_NONE as _, what as _, ext_w.as_ptr(), verb.as_ptr(), buf.as_mut_ptr(), &mut len) };
        if hr != 0 || len == 0 {
            return None;
        }
        let text = String::from_utf16_lossy(&buf[..(len as usize).saturating_sub(1)]);
        let text = text.trim().to_string();
        (!text.is_empty()).then_some(text)
    }

    fn exe_name(path: &str) -> String {
        Path::new(path).file_name().map(|n| n.to_string_lossy().to_ascii_lowercase()).unwrap_or_default()
    }

    /// 지금 기본 앱이 두글인가 — 설치본(doogle.exe)과 개발 실행본(doogle-desk.exe) 모두 두글로 친다
    fn opens_with_doogle(executable: Option<&str>) -> bool {
        let Some(executable) = executable else { return false };
        let name = exe_name(executable);
        if name == "doogle.exe" || name == "doogle-desk.exe" {
            return true;
        }
        std::env::current_exe().ok().is_some_and(|me| exe_name(&me.to_string_lossy()) == name)
    }

    pub fn status() -> Result<DefaultAppStatus, String> {
        let exts = EXTENSIONS
            .iter()
            .map(|ext| {
                let executable = assoc_query(ext, ASSOCSTR_EXECUTABLE as i32);
                let is_default = opens_with_doogle(executable.as_deref());
                let current = if is_default {
                    Some(APP_NAME.to_string())
                } else {
                    assoc_query(ext, ASSOCSTR_FRIENDLYAPPNAME as i32).or_else(|| executable.as_deref().map(exe_name))
                };
                ExtStatus { ext: ext.to_string(), is_default, current }
            })
            .collect();
        Ok(DefaultAppStatus { supported: true, exts, hint: None })
    }

    /// 두글을 .hwp/.hwpx 처리 앱으로 등록한다 (HKCU, 관리자 권한 없이). 여러 번 불러도 같다.
    fn register() -> Result<(), String> {
        let exe = std::env::current_exe().map_err(|e| format!("실행 파일 위치를 알 수 없습니다: {e}"))?;
        let exe = exe.to_string_lossy().to_string();
        let exe_file = Path::new(&exe).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "doogle.exe".into());
        let open_cmd = format!("\"{exe}\" \"%1\"");
        let icon = format!("\"{exe}\",0");

        for ext in EXTENSIONS {
            let pid = prog_id(ext);
            let base = format!(r"Software\Classes\{pid}");
            set_str(&base, None, type_name(ext))?;
            set_str(&base, Some("FriendlyTypeName"), type_name(ext))?;
            set_str(&format!(r"{base}\DefaultIcon"), None, &format!("\"{exe}\",-{}", icon_resource(ext)))?;
            set_str(&format!(r"{base}\shell\open"), Some("FriendlyAppName"), APP_NAME)?;
            set_str(&format!(r"{base}\shell\open\command"), None, &open_cmd)?;
            // "연결 프로그램" 목록에 두글이 오르게
            set_str(&format!(r"Software\Classes\{ext}\OpenWithProgids"), Some(&pid), "")?;
            set_str(&format!(r"{CAPABILITIES}\FileAssociations"), Some(ext), &pid)?;
            set_str(&format!(r"Software\Classes\Applications\{exe_file}\SupportedTypes"), Some(ext), "")?;
        }
        set_str(&format!(r"Software\Classes\Applications\{exe_file}"), Some("FriendlyAppName"), APP_NAME)?;
        set_str(&format!(r"Software\Classes\Applications\{exe_file}\shell\open\command"), None, &open_cmd)?;
        set_str(CAPABILITIES, Some("ApplicationName"), APP_NAME)?;
        set_str(CAPABILITIES, Some("ApplicationDescription"), "HWP/HWPX 편집기")?;
        set_str(CAPABILITIES, Some("ApplicationIcon"), &icon)?;
        set_str(r"Software\RegisteredApplications", Some(REGISTERED_NAME), CAPABILITIES)?;
        // 탐색기가 연결 정보를 다시 읽게 한다
        unsafe { SHChangeNotify(SHCNE_ASSOCCHANGED as _, SHCNF_IDLIST as _, null::<c_void>(), null::<c_void>()) };
        Ok(())
    }

    /// 등록한 뒤 Windows 설정의 "기본 앱 › 두글" 화면을 연다. 실제 선택은 사용자가 그 화면에서 한다.
    pub fn set_default_app() -> Result<(), String> {
        register()?;
        let uri = wide(&format!("ms-settings:defaultapps?registeredAppUser={REGISTERED_NAME}"));
        let verb = wide("open");
        // SAFETY: 문자열 버퍼는 호출 동안 살아 있다.
        let result = unsafe { ShellExecuteW(null_mut(), verb.as_ptr(), uri.as_ptr(), null(), null(), SW_SHOWNORMAL) };
        if (result as isize) <= 32 {
            return Err("Windows 설정을 열지 못했습니다. 설정 › 앱 › 기본 앱에서 두글을 찾아 바꾸세요.".into());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    /// 읽기만 한다 — 레지스트리를 바꾸지 않는다
    #[test]
    fn status_lists_both_extensions() {
        let s = super::status().expect("status");
        assert_eq!(s.exts.iter().map(|e| e.ext.as_str()).collect::<Vec<_>>(), vec![".hwp", ".hwpx"]);
        for e in &s.exts {
            eprintln!("{} → {:?} (두글: {})", e.ext, e.current, e.is_default);
        }
    }
}
