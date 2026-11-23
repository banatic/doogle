; .hwp/.hwpx 연결 — 설치 프로그램은 기본 앱을 바꾸지 않는다.
;
; 예전 설치본은 tauri.conf.json fileAssociations 로 HKCU\Software\Classes\.hwp(.hwpx) 의 기본값을
; "HWP document"(·"HWPX document")로 덮어써서, 묻지 않고 한글 대신 두글이 파일을 열게 했다.
; 지금은 fileAssociations 를 Windows 설치본에서 뺐고(macOS·Linux 설정에만 있다), 기본 앱은
; 사용자가 두글 안에서 동의한 뒤 Windows 설정 화면에서 직접 고른다(src/assoc.rs, shell/default-app-ask.ts).
;
; 설치(·업데이트) 때 하는 일:
;  1. 예전 설치본이 덮어쓴 기본값을 되돌린다 — 값이 아직 우리 것일 때만. 백업이 있으면 백업으로,
;     없으면 우리 값을 지워 원래 앱(대개 HKLM 에 등록된 한글)이 다시 열게 한다.
;     사용자가 Windows 에서 직접 고른 기본 앱(UserChoice)은 건드리지 않는다. 그 선택이
;     "HWP document" ProgID 를 가리킬 수 있어 그 키는 남긴다.
;  2. "연결 프로그램" 목록에만 두글을 올린다(OpenWithProgids). 기본값은 쓰지 않는다.
;  3. 형식별 아이콘(실행 파일 리소스 32513 = HWP, 32514 = HWPX — build.rs).
; 레지스트리 값은 ASCII 로 둔다(이 파일의 인코딩과 무관하게). 한국어 이름은 사용자가 동의할 때
; assoc.rs register() 가 덧쓴다.
!include LogicLib.nsh

!macro DOOGLE_UNGRAB EXT CLASS
  ReadRegStr $0 SHCTX "Software\Classes\.${EXT}" ""
  ${If} $0 == "${CLASS}"
    ReadRegStr $1 SHCTX "Software\Classes\.${EXT}" "${CLASS}_backup"
    ${If} $1 == ""
      DeleteRegValue SHCTX "Software\Classes\.${EXT}" ""
    ${Else}
      WriteRegStr SHCTX "Software\Classes\.${EXT}" "" "$1"
    ${EndIf}
  ${EndIf}
  DeleteRegValue SHCTX "Software\Classes\.${EXT}" "${CLASS}_backup"
!macroend

; src/assoc.rs register() 와 같은 ProgID (Doogle.hwp / Doogle.hwpx)
!macro DOOGLE_OPENWITH EXT TYPENAME ICON
  WriteRegStr SHCTX "Software\Classes\Doogle.${EXT}" "" "${TYPENAME}"
  WriteRegStr SHCTX "Software\Classes\Doogle.${EXT}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",-${ICON}"
  WriteRegStr SHCTX "Software\Classes\Doogle.${EXT}\shell\open\command" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\" $\"%1$\""
  WriteRegStr SHCTX "Software\Classes\.${EXT}\OpenWithProgids" "Doogle.${EXT}" ""
!macroend

!macro DOOGLE_LEGACY_ICON CLASS ICON
  ClearErrors
  ReadRegStr $0 SHCTX "Software\Classes\${CLASS}\shell\open\command" ""
  ${IfNot} ${Errors}
    WriteRegStr SHCTX "Software\Classes\${CLASS}\DefaultIcon" "" "$\"$INSTDIR\${MAINBINARYNAME}.exe$\",-${ICON}"
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro DOOGLE_UNGRAB "hwp" "HWP document"
  !insertmacro DOOGLE_UNGRAB "hwpx" "HWPX document"
  !insertmacro DOOGLE_OPENWITH "hwp" "HWP Document" "32513"
  !insertmacro DOOGLE_OPENWITH "hwpx" "HWPX Document" "32514"
  ; 예전 ProgID 가 남아 있으면(UserChoice 가 아직 가리킬 수 있다) 형식별 아이콘만 맞춘다
  !insertmacro DOOGLE_LEGACY_ICON "HWP document" "32513"
  !insertmacro DOOGLE_LEGACY_ICON "HWPX document" "32514"
  ; 탐색기가 연결 정보를 다시 읽게 한다 (SHCNE_ASSOCCHANGED)
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  !insertmacro DOOGLE_UNGRAB "hwp" "HWP document"
  !insertmacro DOOGLE_UNGRAB "hwpx" "HWPX document"
  DeleteRegValue SHCTX "Software\Classes\.hwp\OpenWithProgids" "Doogle.hwp"
  DeleteRegValue SHCTX "Software\Classes\.hwpx\OpenWithProgids" "Doogle.hwpx"
  DeleteRegValue SHCTX "Software\Classes\.hwp\OpenWithProgids" "HWP document"
  DeleteRegValue SHCTX "Software\Classes\.hwpx\OpenWithProgids" "HWPX document"
  DeleteRegKey SHCTX "Software\Classes\Doogle.hwp"
  DeleteRegKey SHCTX "Software\Classes\Doogle.hwpx"
  DeleteRegKey SHCTX "Software\Classes\HWP document"
  DeleteRegKey SHCTX "Software\Classes\HWPX document"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Doogle"
  DeleteRegKey SHCTX "Software\Doogle\Capabilities"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
