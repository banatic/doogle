fn main() {
    // tauri-build 는 tauri.conf.json · capabilities 가 바뀔 때만 다시 돈다. 아이콘만 바꾸면 실행 파일에
    // 박히는 Windows 아이콘 리소스(resource.lib)가 옛것으로 남아 개발 실행(tauri dev)에 옛 아이콘이 뜬다.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}
