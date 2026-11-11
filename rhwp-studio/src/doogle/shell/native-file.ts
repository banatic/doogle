/**
 * 데스크탑에서 디스크의 파일을 가리키는 "저장 손잡이".
 *
 * 편집기의 저장(upstream command/file-system-access.ts)은 File System Access 의 파일 핸들에 쓴다:
 * 핸들이 있으면 「저장」이 그 자리에 쓰고, 없으면 저장 대화상자를 띄운다. 데스크탑 셸은 파일을 경로로 열기
 * 때문에 지금까지 핸들이 없었고, 그래서 디스크에서 연 문서의 Ctrl+S 가 매번 "다른 이름으로 저장" 이 되었다.
 * 여기서 같은 모양의 핸들을 경로 기반으로 만들어 넘긴다 — 쓰기는 doogle-desk 의 `save_file`
 * (같은 폴더의 임시 파일에 쓴 뒤 이름 바꾸기)이 한다.
 *
 *  - `deskFileHandle(path)`: 열 때 `host.loadDocument(…, { fileHandle })` 로 넘긴다.
 *  - `installNativeSavePicker()`: 「다른 이름으로 저장」의 대화상자를 OS 것으로 바꾸고 고른 경로의 핸들을 준다.
 *  - 쓰기가 끝나면 `doogle:doc-path` 로 경로를 알려 제목 막대·「폴더에서 보기」·대화 묶음이 새 자리를 따른다.
 *
 * 핸들은 일부러 복제할 수 없게(함수가 제 속성) 만든다 — upstream 의 최근 문서 저장소가 핸들을 IndexedDB 에
 * 넣으려다 실패하면 핸들 없이 기록하고, 데스크탑의 최근 문서 카드는 경로로 다시 연다.
 */
import * as desk from '../ui/desk-bridge.ts';

/** 문서 경로를 알리는 window 이벤트 (shell/doc-state.ts 의 DOC_PATH_EVENT 와 같은 이름) */
const DOC_PATH_EVENT = 'doogle:doc-path';

export interface DeskFileHandle {
  readonly kind: 'file';
  readonly name: string;
  /** 디스크 전체 경로 */
  readonly path: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void> }>;
  isSameEntry(other: unknown): Promise<boolean>;
  queryPermission(): Promise<'granted'>;
  requestPermission(): Promise<'granted'>;
}

/** 파일 입출력 — 시험에서 바꿔 끼운다 */
export interface DeskFileIo {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  /** 쓰기가 끝난 뒤 (경로를 화면에 알린다) */
  written?(path: string): void;
}

const defaultIo: DeskFileIo = {
  readFile: (path) => desk.readFile(path),
  writeFile: (path, bytes) => desk.writeFile(path, bytes),
  written: (path) => window.dispatchEvent(new CustomEvent(DOC_PATH_EVENT, { detail: { path } })),
};

/** 같은 파일인지 비교할 꼴 — Windows 경로는 대소문자·구분자를 가리지 않는다 */
export function pathKey(path: string): string {
  return /^[a-z]:[\\/]|^\\\\/i.test(path) ? path.replace(/\//g, '\\').toLowerCase() : path;
}

export function isDeskFileHandle(value: unknown): value is DeskFileHandle {
  return !!value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'file'
    && typeof (value as { path?: unknown }).path === 'string' && typeof (value as { createWritable?: unknown }).createWritable === 'function';
}

export function deskFileHandle(path: string, io: DeskFileIo = defaultIo): DeskFileHandle {
  const name = desk.baseName(path);
  return {
    kind: 'file',
    name,
    path,
    getFile: async () => new File([await io.readFile(path) as BlobPart], name),
    // 조각을 모아 두었다가 close() 에서 한 번에 쓴다 — 쓰다 만 파일이 남지 않게 (쓰기 자체도 임시 파일 + 이름 바꾸기)
    createWritable: async () => {
      const parts: Blob[] = [];
      let closed = false;
      return {
        write: async (data: Blob) => {
          if (closed) throw new Error('이미 닫힌 파일입니다');
          parts.push(data);
        },
        close: async () => {
          if (closed) return;
          closed = true;
          const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
          if (bytes.length === 0) throw new Error('저장할 내용이 없습니다');
          await io.writeFile(path, bytes);
          io.written?.(path);
        },
      };
    },
    isSameEntry: async (other: unknown) => isDeskFileHandle(other) && pathKey(other.path) === pathKey(path),
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
  };
}

let installed = false;

/**
 * 「다른 이름으로 저장」이 띄우는 저장 대화상자를 OS 것으로 바꾼다(데스크탑 전용, 한 번만).
 * 편집기는 `window.showSaveFilePicker` 를 부르고 돌려받은 핸들에 쓴다 — WebView 의 것 대신
 * doogle-desk 의 대화상자를 띄워 경로를 아는 핸들을 준다. 취소는 File System Access 와 같이 AbortError.
 */
export function installNativeSavePicker(): void {
  if (installed || !desk.isDesk()) return;
  installed = true;
  const target = window as unknown as { showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<DeskFileHandle> };
  target.showSaveFilePicker = async (options) => {
    const path = await desk.pickSaveFile(options?.suggestedName);
    if (!path) throw new DOMException('저장을 취소했습니다', 'AbortError');
    return deskFileHandle(path);
  };
}
