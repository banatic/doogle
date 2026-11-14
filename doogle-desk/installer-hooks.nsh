; 설치 프로그램은 .hwp/.hwpx 연결(tauri.conf.json fileAssociations)의 아이콘을 앱 아이콘으로 쓴다.
; 설치가 끝난 뒤 형식별 아이콘(실행 파일 리소스 32513 = HWP, 32514 = HWPX — build.rs)으로 바꾼다.
; 키 이름은 fileAssociations 의 name 과 같아야 한다.
!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\HWP document\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",-32513"
  WriteRegStr SHCTX "Software\Classes\HWPX document\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",-32514"
  ; 탐색기가 아이콘을 다시 읽게 한다 (SHCNE_ASSOCCHANGED)
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
