#!/usr/bin/env sh
# 두글(doogle) upstream 동기화 — upstream(edwardkim/rhwp)을 merge 하고 .doogle-prune 에
# 걸리는 경로(modify/delete 충돌·upstream 이 새로 추가한 파일)를 다시 git rm 한다.
#
# 사용법 (저장소 루트에서):
#   scripts/doogle-sync-upstream.sh               # upstream/main merge → prune → 충돌 없으면 commit
#   scripts/doogle-sync-upstream.sh devel         # 다른 upstream 브랜치
#   scripts/doogle-sync-upstream.sh --no-commit   # merge 결과를 commit 하지 않고 멈춘다
#   scripts/doogle-sync-upstream.sh --prune-only  # merge 없이 지금 index 에서 prune 만
#
# 환경 변수: DOOGLE_UPSTREAM_REMOTE (기본 upstream)
set -eu

remote="${DOOGLE_UPSTREAM_REMOTE:-upstream}"
branch="main"
no_commit=0
prune_only=0
for arg in "$@"; do
  case "${arg}" in
    --no-commit) no_commit=1 ;;
    --prune-only) prune_only=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    -*) echo "알 수 없는 옵션: ${arg}" >&2; exit 2 ;;
    *) branch="${arg}" ;;
  esac
done

root="$(git rev-parse --show-toplevel)"
cd "${root}"
prune_file="${root}/.doogle-prune"
[ -f "${prune_file}" ] || { echo ".doogle-prune 이 없습니다" >&2; exit 1; }

# index 의 경로 중 .doogle-prune 에 걸리는 것(예외 '!' 제외)을 출력한다. 접두 일치만 쓴다.
pruned_paths() {
  git -c core.quotepath=off ls-files | awk -v pf="${prune_file}" '
    BEGIN {
      while ((getline l < pf) > 0) {
        sub(/\r$/, "", l); sub(/^[ \t]+/, "", l); sub(/[ \t]+$/, "", l)
        if (l == "" || substr(l, 1, 1) == "#") continue
        if (substr(l, 1, 1) == "!") keep[++nk] = substr(l, 2); else pr[++np] = l
      }
    }
    function hit(path, s) { return path == s || index(path, s "/") == 1 }
    {
      m = 0
      for (i = 1; i <= np; i++) if (hit($0, pr[i])) { m = 1; break }
      if (!m) next
      for (i = 1; i <= nk; i++) if (hit($0, keep[i])) next
      print
    }' | sort -u
}

prune() {
  list="$(pruned_paths)"
  if [ -z "${list}" ]; then
    echo "prune: 다시 지울 경로 없음"
    return 0
  fi
  count="$(printf '%s\n' "${list}" | wc -l | tr -d ' ')"
  echo "prune: .doogle-prune 경로 ${count}개를 git rm 합니다"
  printf '%s\n' "${list}" |
    git --literal-pathspecs rm -r -f -q --sparse --ignore-unmatch --pathspec-from-file=-
}

warn_cargo_targets() {
  # upstream 이 Cargo.toml 에 [[test]]/[[bin]]/[[example]]·workspace member 를 더하면 지운 경로를 가리킨다.
  if grep -nE '^(path *= *"(tests|tools|packaging|src/bin|src/main\.rs|src/tools)|members *=.*(tools|bindings))' Cargo.toml >/dev/null 2>&1; then
    echo "" >&2
    echo "주의: Cargo.toml 이 지운 경로를 가리킵니다. 해당 [[test]]/[[bin]]/[[example]]/members 를 지우세요:" >&2
    grep -nE '^(path *= *"(tests|tools|packaging|src/bin|src/main\.rs|src/tools)|members *=.*(tools|bindings))' Cargo.toml >&2
  fi
}

if [ "${prune_only}" = "1" ]; then
  prune
  warn_cargo_targets
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "작업 트리에 commit 하지 않은 변경이 있습니다. 먼저 commit 하거나 stash 하세요." >&2
  exit 1
fi

echo "== git fetch ${remote}"
git fetch "${remote}"

echo "== git merge ${remote}/${branch}"
git merge --no-ff --no-commit "${remote}/${branch}" || true

prune
warn_cargo_targets

conflicts="$(git -c core.quotepath=off diff --name-only --diff-filter=U)"
if [ -n "${conflicts}" ]; then
  echo ""
  echo "남은 충돌 — 직접 해결한 뒤 git add 하고 git commit 하세요:"
  printf '%s\n' "${conflicts}" | sed 's/^/  /'
  exit 1
fi

if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
  if [ "${no_commit}" = "1" ]; then
    echo "충돌 없음. --no-commit 이라 commit 하지 않았습니다 (git commit 으로 마무리)."
  else
    git commit --no-edit
    echo "merge commit 완료."
  fi
else
  echo "merge 할 새 변경이 없습니다."
fi
