// Claude 데스크탑 앱 안의 Claude Code 찾기 (claude-sdk.mjs desktopClaudeBinary)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { desktopClaudeBinary } from '../src/providers/claude-sdk.mjs';

test('desktop Claude: picks the newest claude.exe under Claude-Data and %APPDATA%\Claude', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dg-claude-'));
  try {
    const local = path.join(root, 'local');
    const roaming = path.join(root, 'roaming');
    const put = (dir, at) => {
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'claude.exe');
      writeFileSync(file, '');
      utimesSync(file, at, at);
      return file;
    };
    put(path.join(local, 'Claude-Data', 'claude_abc', 'claude-code', '2.1.300', 'b1'), 1000);
    const newest = put(path.join(local, 'Claude-Data', 'claude_abc', 'claude-code', '2.1.321', 'b2'), 3000);
    put(path.join(roaming, 'Claude', 'claude-code', '2.1.200'), 2000);
    put(path.join(local, 'Claude-Data', 'other', 'claude-code', 'x'), 9000); // claude_ 가 아닌 폴더는 보지 않는다
    assert.equal(desktopClaudeBinary({ LOCALAPPDATA: local, APPDATA: roaming }, 'win32'), newest);
    assert.equal(desktopClaudeBinary({ LOCALAPPDATA: path.join(root, 'none') }, 'win32'), null);
    assert.equal(desktopClaudeBinary({ LOCALAPPDATA: local }, 'darwin'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
