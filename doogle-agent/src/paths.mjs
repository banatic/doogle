// 두글 앱 데이터 경로 (CONTRACT §1).
import os from 'node:os';
import path from 'node:path';

/**
 * 플랫폼별 두글 앱 데이터 디렉터리.
 * Windows `%APPDATA%/doogle`, macOS `~/Library/Application Support/doogle`,
 * Linux `$XDG_CONFIG_HOME/doogle` (기본 `~/.config/doogle`).
 * `DOOGLE_DATA_DIR`이 절대경로면 그것을 쓴다(테스트·포터블 실행용).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {NodeJS.Platform} [platform]
 * @param {string} [home]
 */
export function appDataDir(env = process.env, platform = process.platform, home = os.homedir()) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (env.DOOGLE_DATA_DIR && p.isAbsolute(env.DOOGLE_DATA_DIR)) return p.resolve(env.DOOGLE_DATA_DIR);
  if (platform === 'win32') {
    const base = env.APPDATA && p.isAbsolute(env.APPDATA) ? env.APPDATA : p.join(home, 'AppData', 'Roaming');
    return p.join(base, 'doogle');
  }
  if (platform === 'darwin') return p.join(home, 'Library', 'Application Support', 'doogle');
  const base = env.XDG_CONFIG_HOME && p.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : p.join(home, '.config');
  return p.join(base, 'doogle');
}

/** hub.json 경로 */
export function hubJsonPath(env = process.env, platform = process.platform, home = os.homedir()) {
  return path.join(appDataDir(env, platform, home), 'hub.json');
}
