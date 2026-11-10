# 두글 릴리스와 자동 업데이트

두글(doogle-desk, Tauri 2) 설치본은 GitHub Actions `Doogle Release`
(`.github/workflows/doogle-release.yml`)가 만들고, 설치된 앱은 GitHub 릴리스의
`latest.json`을 보고 스스로 업데이트한다.

## 한 번만 하는 준비

1. **업데이트 서명 키** — 이미 만들어 두었다(저장소 밖).
   - 개인 키: `C:/Users/user/.tauri/doogle-updater.key` (암호 없음). 저장소·채팅·이슈에 붙이지 않는다.
   - 공개 키: `C:/Users/user/.tauri/doogle-updater.key.pub` → `doogle-desk/tauri.conf.json`의
     `plugins.updater.pubkey`에 들어가 있다.
   - 개인 키를 잃어버리면 이미 설치된 앱은 새 업데이트를 받지 못한다(새 키로 서명한 빌드를 검증할 수 없다).
     안전한 곳에 백업한다. 다시 만들려면 `npx tauri signer generate --ci -w <경로>` 후 공개 키를 바꾸고,
     기존 사용자는 새 설치본을 직접 받아야 한다.
2. **저장소 secret 등록** (banatic/doogle → Settings → Secrets and variables → Actions):

   ```sh
   gh secret set TAURI_SIGNING_PRIVATE_KEY --repo banatic/doogle < C:/Users/user/.tauri/doogle-updater.key
   gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --repo banatic/doogle --body ""
   ```

   암호가 빈 키라도 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`는 빈 값으로 만들어 둔다.
   웹 화면이 빈 secret을 거부하면 이 secret은 만들지 않아도 된다(workflow에서 빈 문자열로 들어간다).
3. **(선택) Windows Authenticode 서명** — SmartScreen 경고를 줄이려면 코드 서명 인증서를 등록한다.
   - `WINDOWS_CERTIFICATE`: PFX 파일을 base64로 인코딩한 값
     (`[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))`)
   - `WINDOWS_CERTIFICATE_PASSWORD`: PFX 암호
   - 둘 다 있을 때만 workflow가 인증서를 가져와 thumbprint를 Tauri 설정 overlay로 넘긴다. 없으면 서명 없이 빌드한다.
   - EV/클라우드 HSM 인증서(PFX로 내보낼 수 없는 것)는 이 방식이 안 된다. 그때는
     `bundle.windows.signCommand`(예: Azure Trusted Signing, `trusted-signing-cli`)를 overlay로 넘기는 방식으로 바꾼다.
4. **fork에서 Actions 켜기** — banatic/doogle → Actions 탭 → "I understand my workflows, go ahead and enable them".
   Settings → Actions → General → Workflow permissions는 기본값이어도 된다(workflow가 `contents: write`를 직접 요청한다).

### upstream workflow

upstream rhwp 의 workflow 는 저장소에서 지웠다(`.doogle-prune` 의 `.github`). `.github/workflows/` 에는
`doogle-release.yml` 만 남는다. upstream 을 merge 해도 동기화 스크립트(아래)가 새 workflow 를 다시 지운다.
두글 릴리스 태그는 `doogle-v{version}`이다(fork 에는 upstream 태그 `v0.5.0`…`v0.9.x`가 이미 있어
`v{version}`을 쓰면 버전이 겹친다).

## 릴리스 절차

1. 버전을 세 곳에서 같은 값으로 올린다(workflow가 다르면 실패한다).
   - `doogle-desk/tauri.conf.json` → `version`
   - `doogle-desk/Cargo.toml` → `[package] version` (그 뒤 `cargo check`로 `Cargo.lock` 갱신)
   - `doogle-desk/package.json` → `version` (`npm install --package-lock-only`로 lock 갱신)
2. `doogle` 브랜치의 변경을 `release` 브랜치에 merge하고 push한다.
   수동 실행: Actions → Doogle Release → Run workflow(브랜치 `release`, 릴리스 노트 입력 가능).
3. workflow 순서: 버전 확인·태그 `doogle-v{version}` 중복 검사 → WASM(`pkg/`) 빌드 → npm 의존성 →
   `tauri-action`이 NSIS 설치본, `.sig`, `latest.json`을 **초안 릴리스** `두글 v{version}`에 올린다.
4. GitHub Releases에서 초안을 확인하고 **Publish release**를 누른다.
   - **초안은 `releases/latest/download/latest.json`으로 제공되지 않는다.** Publish 전에는 아무 앱도 업데이트를 보지 못한다.
   - Pre-release로 표시하면 "latest"가 되지 않으므로 업데이트가 배포되지 않는다.
   - 앱의 업데이트 팝오버에 보이는 노트는 빌드 시점의 `latest.json`의 `notes`(push면 마지막 커밋 메시지,
     수동 실행이면 입력값)다. Publish 전에 릴리스 본문만 고쳐도 앱의 노트는 바뀌지 않는다. 바꾸려면
     `latest.json`의 `notes`를 고쳐 다시 올린다(서명은 설치본에 대한 것이라 노트 수정은 서명과 무관하다).

## 앱이 업데이트를 확인하는 방식

- 설정: `doogle-desk/tauri.conf.json`의 `plugins.updater`
  - `endpoints`: `https://github.com/banatic/doogle/releases/latest/download/latest.json`
  - `pubkey`: 위 공개 키. 설치본 서명을 이 키로 검증한다.
  - `windows.installMode: "passive"`: 진행 막대만 있는 NSIS 설치.
  - `bundle.createUpdaterArtifacts: true`: 빌드 때 `.sig`를 만든다(`TAURI_SIGNING_PRIVATE_KEY` 필요).
- Rust(`doogle-desk/src/updater.rs`): `update_check`가 새 버전 메타데이터를 돌려주고,
  `update_install`이 내려받고(`doogle://update-progress` 이벤트) hub를 내린 뒤 설치하고 재시작한다.
  Windows는 설치기가 앱을 종료하고 설치 뒤 다시 띄운다.
- 화면(`rhwp-studio/src/doogle/shell/updater.ts`): 시작 10초 뒤, 그 뒤 6시간마다 확인한다.
  새 버전이 있으면 제목 막대에 `업데이트 v{ver}` 알약 → 팝오버(릴리스 노트, 진행 막대, 지금 설치(재시작) / 나중에).
  파일 백스테이지에 현재 버전과 `업데이트 확인`이 있다. 설치 전에 저장 안 한 문서 확인을 거친다.
- 창 닫기(제목 막대 X, Alt+F4, 작업 표시줄)도 같은 저장 안 한 문서 확인을 거친다
  (`doogle://close-requested` → 확인 대화상자 → `confirm_close`).

## 알려진 공백

- **Node 22+ 필요** — agent hub(doogle-agent)는 사용자 PATH의 Node 22 이상으로 실행된다.
  Node가 없거나 오래되면 편집기는 동작하지만 AI 사이드바는 쓸 수 없다.
  후속 과제: Node 런타임을 Tauri sidecar(`bundle.externalBin`)나 리소스로 함께 묶고
  `hub.rs`가 묶인 런타임을 먼저 찾게 한다(설치본 크기 +30~40 MB, Node 보안 업데이트도 앱 릴리스로 따라가야 한다).
- macOS·Linux 빌드는 workflow matrix에 주석으로만 있다. macOS는 서명·notarization이 필요하다.
- macOS에서 Cmd+Q(앱 종료)는 창 닫기 확인을 거치지 않는다(`ExitRequested` 미처리).

## upstream 동기화

두글은 upstream(edwardkim/rhwp)에서 엔진·편집기만 쓰고 나머지(mydocs, tests, 확장 프로그램, CLI 바이너리,
upstream CI 등)는 지웠다. 지운 경로는 저장소 루트의 `.doogle-prune` 에 있다(디렉터리 접두 일치, `!` 는 남길 예외).

```powershell
scripts/doogle-sync-upstream.ps1              # git fetch upstream → merge upstream/main → .doogle-prune 경로 git rm → 충돌 없으면 commit
scripts/doogle-sync-upstream.ps1 -NoCommit    # commit 하지 않고 멈춘다
scripts/doogle-sync-upstream.ps1 -PruneOnly   # merge 없이 prune 만
```

POSIX 셸은 `scripts/doogle-sync-upstream.sh [브랜치] [--no-commit|--prune-only]`.

- upstream 이 지운 경로의 파일을 고치면(modify/delete 충돌) 또는 그 아래에 새 파일을 더하면 스크립트가 다시 `git rm` 한다.
- 그 밖의 충돌은 목록만 출력하고 멈춘다. 직접 해결하고 `git add` → `git commit`.
- `Cargo.toml` 은 자주 충돌한다. 두글 쪽에는 `[[bin]]`·`[[test]]`·`[[example]]` 과 `tools/*`·`bindings/*` workspace member 가 없다.
  upstream 이 이런 항목을 더하면 지운 파일을 가리키므로 빼고, `Cargo.lock` 은 `cargo metadata --offline` 으로 다시 맞춘다.
  스크립트가 지운 경로를 가리키는 `Cargo.toml` 줄을 경고로 보여 준다.
- upstream lib 이 새 `include_str!`/`include_bytes!` 로 지운 경로(예: `samples/`, `tests/fixtures/`)의 파일을 읽기 시작하면
  WASM 빌드가 깨진다. 그 파일을 `.doogle-prune` 에 `!경로` 로 추가하고 `git checkout upstream/main -- 경로` 로 되살린다.
- merge 뒤 `cargo check --lib --target wasm32-unknown-unknown`, rhwp-studio `npm run build`, doogle-agent `npm test` 로 확인한다.
