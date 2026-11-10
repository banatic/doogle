#!/usr/bin/env node
// 두글 hub 실행 진입점 (Tauri sidecar). CONTRACT §1.
//   DOOGLE_HUB_PORT  (0 = 랜덤)
//   DOOGLE_HUB_TOKEN (없으면 랜덤 생성)
//   DOOGLE_HUB_EXIT_ON_STDIN_CLOSE=1 (stdin EOF 시 종료 — sidecar용)
// 기동 후 표준출력 첫 줄: DOOGLE_HUB_READY {"port":..,"token":".."}
import { createHub } from '../src/hub.mjs';

const port = Number.parseInt(process.env.DOOGLE_HUB_PORT ?? '0', 10);

let hub;
try {
  hub = await createHub({
    port: Number.isFinite(port) && port >= 0 && port < 65536 ? port : 0,
    token: process.env.DOOGLE_HUB_TOKEN || undefined,
  });
} catch (err) {
  process.stderr.write(`[doogle-hub] 시작 실패: ${err?.stack ?? err}\n`);
  process.exit(1);
}

process.stdout.write(`DOOGLE_HUB_READY ${JSON.stringify({ port: hub.port, token: hub.token })}\n`);

let closing = false;
async function shutdown(code = 0) {
  if (closing) return;
  closing = true;
  const force = setTimeout(() => process.exit(code), 5000);
  force.unref();
  try {
    await hub.close();
  } finally {
    process.exit(code);
  }
}
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
// DOOGLE_HUB_EXIT_ON_STDIN_CLOSE=1이면 stdin이 닫힐 때(부모 Tauri 종료) 함께 종료한다.
if (process.env.DOOGLE_HUB_EXIT_ON_STDIN_CLOSE === '1') {
  process.stdin.on('end', () => void shutdown(0));
  process.stdin.on('error', () => {});
  process.stdin.resume();
}
