#!/usr/bin/env node
// 설치본 빌드 직전 준비 (tauri.bundle.conf.json 의 beforeBuildCommand — 로컬·CI 모두 이 길로 간다).
//
//  1. rhwp-studio/dist 를 지우고 화면을 새로 빌드한다.
//     Node 24 의 fs.rmSync(recursive) 는 Windows 에서 한글 등 비 ASCII 경로(예: D:\dev\두글\...)를 지우다
//     네이티브 오류(0xC0000409)로 죽는다. vite build 도 기존 dist 를 비울 때 같은 함수를 써서 죽으므로,
//     dist 는 여기서 파일 단위로 먼저 지워 vite 가 지울 것이 없게 한다(removeTree).
//  2. doogle-agent 를 target/agent-stage 로 복사한다(설치본 리소스는 이 폴더를 가리킨다). 이때
//     Claude Agent SDK 의 플랫폼별 Claude Code 실행 파일 패키지(@anthropic-ai/claude-agent-sdk-<platform>,
//     Windows 기준 ~330MB)는 뺀다. 두글은 사용자가 설치한 Claude Code(PATH 의 `claude`)를 쓴다 —
//     로그인도 그 CLI 로 하므로 Claude 를 쓰는 사용자는 이미 설치해 두었다(claude-sdk.mjs detect).
//     원본 doogle-agent/node_modules 는 건드리지 않는다(개발 환경 그대로).
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, readdirSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desk = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(desk, '..');
const studio = path.join(repo, 'rhwp-studio');
const agent = path.join(repo, 'doogle-agent');
const stage = path.join(desk, 'target', 'agent-stage');

function step(text) {
  console.log(`[prepare-bundle] ${text}`);
}

/** 폴더를 파일 단위로 지운다 — fs.rmSync(recursive) 의 비 ASCII 경로 충돌을 피한다 */
function removeTree(p) {
  if (!existsSync(p)) return;
  const s = lstatSync(p);
  if (s.isDirectory() && !s.isSymbolicLink()) {
    for (const name of readdirSync(p)) removeTree(path.join(p, name));
    rmdirSync(p);
  } else {
    unlinkSync(p);
  }
}

// 1. 화면 빌드 (빈 dist 에서)
step('rhwp-studio/dist 지우고 빌드');
removeTree(path.join(studio, 'dist'));
// DOOGLE_DESKTOP=1: 서비스 워커를 넣지 않는 데스크탑 빌드 (rhwp-studio/vite.config.ts)
const build = spawnSync('npm run build', {
  cwd: studio,
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, DOOGLE_DESKTOP: '1' },
});
if (build.status !== 0) {
  console.error(`[prepare-bundle] rhwp-studio 빌드 실패 (exit ${build.status})`);
  process.exit(1);
}

// 2. 에이전트 리소스 (Claude Code 실행 파일 패키지 제외)
const PLATFORM_BINARY = /[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-agent-sdk-[^\\/]+$/;
if (!existsSync(path.join(agent, 'node_modules'))) {
  console.error('[prepare-bundle] doogle-agent/node_modules 가 없습니다. doogle-agent 에서 npm ci --omit=dev 를 먼저 실행하세요.');
  process.exit(1);
}
step(`doogle-agent → ${path.relative(repo, stage)} (Claude Code 실행 파일 패키지 제외)`);
removeTree(stage);
let skipped = 0;
for (const part of ['bin', 'src', 'node_modules', 'package.json']) {
  cpSync(path.join(agent, part), path.join(stage, part), {
    recursive: true,
    dereference: true,
    filter: (src) => {
      if (PLATFORM_BINARY.test(src)) {
        skipped++;
        return false;
      }
      return true;
    },
  });
}

function sizeOf(p) {
  const s = statSync(p);
  if (!s.isDirectory()) return s.size;
  return readdirSync(p).reduce((n, name) => n + sizeOf(path.join(p, name)), 0);
}
step(`완료 — 제외한 패키지 ${skipped}개, 리소스 ${(sizeOf(stage) / 1048576).toFixed(1)}MB`);
