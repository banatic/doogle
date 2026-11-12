// 데스크탑 앱이 품고 있는 CLI 실행 파일 찾기 — 버전 폴더 아래에서 가장 최근 것을 고른다.
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export function safeList(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * roots 아래 maxDepth 단계 안에서 이름이 fileName 인 파일 중 수정 시각이 가장 최근 것 (없으면 null).
 * @param {string[]} roots
 * @param {string} fileName 대소문자 무시
 */
export function newestFile(roots, fileName, maxDepth = 3) {
  const want = fileName.toLowerCase();
  let best = null;
  const visit = (dir, depth) => {
    for (const name of safeList(dir)) {
      const full = path.join(dir, name);
      if (name.toLowerCase() === want) {
        try {
          const st = statSync(full);
          if (st.isFile() && (!best || st.mtimeMs > best.at)) best = { file: full, at: st.mtimeMs };
        } catch { /* 지워지는 중 */ }
      } else if (depth < maxDepth) {
        visit(full, depth + 1);
      }
    }
  };
  for (const root of roots) visit(root, 0);
  return best?.file ?? null;
}

/** %LOCALAPPDATA%\Packages 아래 이름이 prefix 로 시작하는 MSIX 패키지 폴더들 */
export function msixPackageDirs(env, prefix) {
  if (!env.LOCALAPPDATA) return [];
  const base = path.join(env.LOCALAPPDATA, 'Packages');
  const p = prefix.toLowerCase();
  return safeList(base).filter((n) => n.toLowerCase().startsWith(p)).map((n) => path.join(base, n));
}
