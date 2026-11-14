/// .hwp/.hwpx 파일 형식 아이콘을 실행 파일에 리소스로 넣는다. 탐색기는 `"doogle.exe",-32513` 처럼
/// 리소스 번호로 가리킨다(src/assoc.rs · installer-hooks.nsh). 앱 아이콘(32512)보다 큰 번호여야
/// 실행 파일의 첫 아이콘이 앱 아이콘으로 남는다. 따로 .rc 를 컴파일하면 앱 아이콘과 번호가 겹쳐
/// 링크가 깨지므로(CVT1100) tauri-build 의 리소스 파일에 덧붙인다.
fn file_icon_rc() -> String {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("icons");
    [(32513, "hwp.ico"), (32514, "hwpx.ico")]
        .iter()
        .map(|(id, file)| format!("{id} ICON \"{}\"\n", dir.join(file).display().to_string().replace('\\', "/")))
        .collect()
}

fn main() {
    // tauri-build 는 tauri.conf.json · capabilities 가 바뀔 때만 다시 돈다. 아이콘만 바꾸면 실행 파일에
    // 박히는 Windows 아이콘 리소스(resource.lib)가 옛것으로 남아 개발 실행(tauri dev)에 옛 아이콘이 뜬다.
    println!("cargo:rerun-if-changed=icons");
    let windows = tauri_build::WindowsAttributes::new().append_rc_content(file_icon_rc());
    tauri_build::try_build(tauri_build::Attributes::new().windows_attributes(windows)).expect("failed to run tauri-build");
}
