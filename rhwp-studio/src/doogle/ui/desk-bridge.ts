/**
 * 두글 데스크탑 셸(doogle-desk, Tauri 2) 호출 — `@tauri-apps/api` 없이 Tauri 가 주입하는
 * `window.__TAURI_INTERNALS__` 를 직접 쓴다. upstream `package.json` 에 의존성을 더하지 않기 위함이다.
 *
 * 브라우저(개발 서버)에서는 모든 함수가 `isDesk() === false` 경로로 조용히 빠진다.
 */

interface TauriInternals {
  invoke<T>(cmd: string, args?: unknown, options?: { headers?: Record<string, string> }): Promise<T>;
  transformCallback(callback: (payload: unknown) => void, once?: boolean): number;
}

export interface DeskHubInfo {
  port: number;
  token: string;
  pid?: number;
}

/** `doogle://hub` 이벤트 페이로드 */
export type DeskHubEvent =
  | { state: 'ready'; port: number; token: string; pid?: number }
  | { state: 'exited'; restartInMs: number }
  | { state: 'failed'; message: string };

function internals(): TauriInternals | null {
  const value = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  return value && typeof value.invoke === 'function' ? value : null;
}

export function isDesk(): boolean {
  return internals() !== null;
}

export function invoke<T>(cmd: string, args?: unknown, options?: { headers?: Record<string, string> }): Promise<T> {
  const tauri = internals();
  if (!tauri) return Promise.reject(new Error('두글 데스크탑 앱에서만 쓸 수 있습니다'));
  return tauri.invoke<T>(cmd, args ?? {}, options);
}

/** Tauri 이벤트 구독. 반환값은 해지 함수다. */
export async function listen<T>(event: string, cb: (payload: T) => void): Promise<() => void> {
  const tauri = internals();
  if (!tauri) return () => {};
  const handler = tauri.transformCallback((raw) => {
    const message = raw as { payload?: T } | null;
    cb(message?.payload as T);
  });
  const eventId = await tauri.invoke<number>('plugin:event|listen', {
    event,
    target: { kind: 'Any' },
    handler,
  });
  return () => {
    void tauri.invoke('plugin:event|unlisten', { event, eventId }).catch(() => {});
  };
}

export function hubInfo(): Promise<DeskHubInfo> {
  return invoke<DeskHubInfo>('hub_info');
}

export function onHubEvent(cb: (event: DeskHubEvent) => void): Promise<() => void> {
  return listen<DeskHubEvent>('doogle://hub', cb);
}

export async function readFile(path: string): Promise<Uint8Array> {
  const data = await invoke<ArrayBuffer | number[]>('open_file', { path });
  return data instanceof ArrayBuffer ? new Uint8Array(data) : Uint8Array.from(data);
}

export function writeFile(path: string, bytes: Uint8Array): Promise<void> {
  return invoke<void>('save_file', bytes, { headers: { 'x-doogle-path': encodeURIComponent(path) } });
}

export function pickOpenFile(): Promise<string | null> {
  return invoke<string | null>('pick_open_file');
}

export function pickSaveFile(suggestedName?: string): Promise<string | null> {
  return invoke<string | null>('pick_save_file', { suggestedName: suggestedName ?? null });
}

/** 파일 연결·두 번째 실행으로 들어온 문서 경로. 가져가면 비워진다. */
export function takeOpenRequests(): Promise<string[]> {
  return invoke<string[]>('take_open_requests');
}

export function onOpenRequest(cb: () => void): Promise<() => void> {
  return listen<unknown>('doogle://open-request', () => cb());
}

/** 외부 주소(로그인 페이지)를 시스템 브라우저로 연다. 브라우저 개발에서는 새 창. */
export async function openExternal(url: string): Promise<void> {
  if (isDesk()) {
    await invoke<void>('open_external', { url });
    return;
  }
  window.open(url, '_blank', 'noopener');
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
