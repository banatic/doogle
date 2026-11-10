<#
.SYNOPSIS
  두글(doogle) upstream 동기화 — upstream(edwardkim/rhwp)을 merge 하고 .doogle-prune 에 걸리는
  경로(modify/delete 충돌·upstream 이 새로 추가한 파일)를 다시 git rm 한다.

.EXAMPLE
  scripts/doogle-sync-upstream.ps1                 # upstream/main merge → prune → 충돌 없으면 commit
  scripts/doogle-sync-upstream.ps1 -Branch devel   # 다른 upstream 브랜치
  scripts/doogle-sync-upstream.ps1 -NoCommit       # merge 결과를 commit 하지 않고 멈춘다
  scripts/doogle-sync-upstream.ps1 -PruneOnly      # merge 없이 지금 index 에서 prune 만
#>
[CmdletBinding()]
param(
  [string]$Branch = 'main',
  [string]$Remote = $(if ($env:DOOGLE_UPSTREAM_REMOTE) { $env:DOOGLE_UPSTREAM_REMOTE } else { 'upstream' }),
  [switch]$NoCommit,
  [switch]$PruneOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Text.UTF8Encoding]::new($false)

$root = (git rev-parse --show-toplevel).Trim()
Set-Location $root
$pruneFile = Join-Path $root '.doogle-prune'
if (-not (Test-Path $pruneFile)) { throw '.doogle-prune 이 없습니다' }

function Get-PruneRules {
  $prune = [Collections.Generic.List[string]]::new()
  $keep = [Collections.Generic.List[string]]::new()
  foreach ($raw in [IO.File]::ReadAllLines($pruneFile, [Text.Encoding]::UTF8)) {
    $line = $raw.Trim()
    if ($line -eq '' -or $line.StartsWith('#')) { continue }
    if ($line.StartsWith('!')) { $keep.Add($line.Substring(1)) } else { $prune.Add($line) }
  }
  [pscustomobject]@{ Prune = $prune; Keep = $keep }
}

function Test-Prefix([string]$Path, [string]$Prefix) {
  $Path -ceq $Prefix -or $Path.StartsWith("$Prefix/", [StringComparison]::Ordinal)
}

# index 의 경로 중 .doogle-prune 에 걸리는 것(예외 '!' 제외). 접두 일치만 쓴다.
function Get-PrunedPaths {
  $rules = Get-PruneRules
  $all = git -c core.quotepath=off ls-files
  $out = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($path in $all) {
    $hit = $false
    foreach ($p in $rules.Prune) { if (Test-Prefix $path $p) { $hit = $true; break } }
    if (-not $hit) { continue }
    $kept = $false
    foreach ($k in $rules.Keep) { if (Test-Prefix $path $k) { $kept = $true; break } }
    if (-not $kept) { [void]$out.Add($path) }
  }
  , @($out)
}

function Invoke-Prune {
  $list = Get-PrunedPaths
  if ($list.Count -eq 0) { Write-Host 'prune: 다시 지울 경로 없음'; return }
  Write-Host "prune: .doogle-prune 경로 $($list.Count)개를 git rm 합니다"
  $tmp = [IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($tmp, (($list -join "`n") + "`n"), [Text.UTF8Encoding]::new($false))
    git --literal-pathspecs rm -r -f -q --sparse --ignore-unmatch "--pathspec-from-file=$tmp"
    if ($LASTEXITCODE -ne 0) { throw "git rm 실패 (exit $LASTEXITCODE)" }
  } finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }
}

function Write-CargoTargetWarning {
  # upstream 이 Cargo.toml 에 [[test]]/[[bin]]/[[example]]·workspace member 를 더하면 지운 경로를 가리킨다.
  $pattern = '^(path *= *"(tests|tools|packaging|src/bin|src/main\.rs|src/tools)|members *=.*(tools|bindings))'
  $hits = Select-String -Path (Join-Path $root 'Cargo.toml') -Pattern $pattern
  if ($hits) {
    Write-Warning 'Cargo.toml 이 지운 경로를 가리킵니다. 해당 [[test]]/[[bin]]/[[example]]/members 를 지우세요:'
    $hits | ForEach-Object { Write-Host "  Cargo.toml:$($_.LineNumber): $($_.Line)" }
  }
}

if ($PruneOnly) {
  Invoke-Prune
  Write-CargoTargetWarning
  exit 0
}

git diff --quiet; $dirty = $LASTEXITCODE -ne 0
git diff --cached --quiet; $dirty = $dirty -or ($LASTEXITCODE -ne 0)
if ($dirty) { throw '작업 트리에 commit 하지 않은 변경이 있습니다. 먼저 commit 하거나 stash 하세요.' }

Write-Host "== git fetch $Remote"
git fetch $Remote
if ($LASTEXITCODE -ne 0) { throw "git fetch $Remote 실패" }

Write-Host "== git merge $Remote/$Branch"
git merge --no-ff --no-commit "$Remote/$Branch"   # 충돌이 나도 계속 진행한다

Invoke-Prune
Write-CargoTargetWarning

$conflicts = @(git -c core.quotepath=off diff --name-only --diff-filter=U)
if ($conflicts.Count -gt 0) {
  Write-Host ''
  Write-Host '남은 충돌 — 직접 해결한 뒤 git add 하고 git commit 하세요:'
  $conflicts | ForEach-Object { Write-Host "  $_" }
  exit 1
}

git rev-parse -q --verify MERGE_HEAD *> $null
if ($LASTEXITCODE -eq 0) {
  if ($NoCommit) {
    Write-Host '충돌 없음. -NoCommit 이라 commit 하지 않았습니다 (git commit 으로 마무리).'
  } else {
    git commit --no-edit
    if ($LASTEXITCODE -ne 0) { throw 'git commit 실패' }
    Write-Host 'merge commit 완료.'
  }
} else {
  Write-Host 'merge 할 새 변경이 없습니다.'
}
