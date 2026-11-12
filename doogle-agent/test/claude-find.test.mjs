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

test('desktop Claude: also looks inside the MSIX package LocalCache', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dg-claude-msix-'));
  try {
    const local = path.join(root, 'local');
    const pkg = path.join(local, 'Packages', 'Claude_pzs8sxrjxfjjc', 'LocalCache');
    const put = (dir, at) => {
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'claude.exe');
      writeFileSync(file, '');
      utimesSync(file, at, at);
      return file;
    };
    put(path.join(pkg, 'Roaming', 'Claude', 'claude-code', '2.1.300'), 1000);
    const newest = put(path.join(pkg, 'Local', 'Claude-Data', 'claude_pzs', 'claude-code', '2.1.321', 'b'), 2000);
    assert.equal(desktopClaudeBinary({ LOCALAPPDATA: local }, 'win32'), newest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('desktop Codex: picks the newest codex.exe in the Codex app bin folders', async () => {
  const { desktopCodexBinary, findCodex } = await import('../src/providers/codex-app-server.mjs');
  const root = mkdtempSync(path.join(os.tmpdir(), 'dg-codex-'));
  try {
    const local = path.join(root, 'local');
    const put = (dir, at) => {
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'codex.exe');
      writeFileSync(file, '');
      utimesSync(file, at, at);
      return file;
    };
    put(path.join(local, 'OpenAI', 'Codex', 'bin', 'old'), 1000);
    const newest = put(path.join(local, 'Packages', 'OpenAI.Codex_2p2nqsd0c76g0', 'LocalCache', 'Local', 'OpenAI', 'Codex', 'bin', 'new'), 2000);
    assert.equal(desktopCodexBinary({ LOCALAPPDATA: local }, 'win32'), newest);
    assert.equal(desktopCodexBinary({ LOCALAPPDATA: path.join(root, 'none') }, 'win32'), null);
    assert.equal(desktopCodexBinary({ LOCALAPPDATA: local }, 'darwin'), null);
    assert.equal(findCodex({ DOOGLE_CODEX_PATH: 'X:/codex.exe' }, 'win32'), 'X:/codex.exe');
    assert.equal(findCodex({ LOCALAPPDATA: local, PATH: path.join(root, 'empty') }, 'win32'), newest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('open terminal: starts the found Claude Code in a new console window, never a login screen', async () => {
  const { openClaudeTerminal } = await import('../src/providers/claude-sdk.mjs');
  const calls = [];
  const spawnFn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return { on() {}, unref() {} }; };
  const exe = String.raw`C:\Users\u\AppData\Local\Claude-Data\claude_x\claude-code\2.1.321\b\claude.exe`;
  assert.equal(openClaudeTerminal({ exe, cwd: String.raw`C:\w`, platform: 'win32', spawnFn }), exe);
  assert.equal(calls[0].cmd, 'cmd.exe');
  assert.equal(calls[0].args.at(-1), `"start "Claude Code" "${exe}""`);
  assert.equal(calls[0].opts.windowsVerbatimArguments, true);
  assert.deepEqual(openClaudeTerminal({ exe: '/usr/local/bin/claude', platform: 'darwin', spawnFn }) && calls[1].args, ['-a', 'Terminal', '/usr/local/bin/claude']);
  assert.throws(() => openClaudeTerminal({ exe: null, spawnFn }), /찾을 수 없습니다/);
});
