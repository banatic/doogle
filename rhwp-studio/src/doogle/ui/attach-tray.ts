/**
 * 입력 상자의 첨부 줄 — 사용자가 올린 참고 파일을 칩으로 보이고, 보낼 때 hub 로 갈 내용을 넘긴다.
 *
 *  - 올리는 길 셋: '+' 단추(파일 고르기), 사이드바에 끌어다 놓기, 입력창에 붙여 넣기(그림·파일).
 *  - 올리자마자 화면에서 읽는다(attach/attach-read.ts) — 읽는 동안에는 "읽는 중", 읽지 못하면 사유를 칩에 적는다.
 *    읽지 못한 칩은 보내지 않는다(지우거나 그대로 두어도 된다).
 *  - 보내면 비운다. 한 번 보낸 파일은 그 대화에 남아 다음 요청에서도 에이전트가 참고한다.
 */
import './attach-tray.css';
import {
  ATTACH_ACCEPT, ATTACH_LIMITS, AttachError, classifyFile, formatBytes, payloadBytes, type AttachKind, type AttachmentPayload,
} from '../attach/attach-core.ts';
import { icon, type IconName } from './icons.ts';

export type AttachReader = (file: File) => Promise<AttachmentPayload>;

interface Draft {
  id: number;
  name: string;
  size: number;
  kind: AttachKind | null;
  status: 'reading' | 'ready' | 'error';
  error?: string;
  payload?: AttachmentPayload;
}

export interface AttachTray {
  /** 칩 줄 — 비어 있으면 숨는다 */
  readonly root: HTMLElement;
  /** 파일 고르기 창을 연다 */
  pick(): void;
  add(files: Iterable<File>): void;
  /** 아직 읽는 중인 파일이 있는가 — 그동안은 보내지 않는다 */
  readonly busy: boolean;
  /** 보낼 수 있는(다 읽은) 파일 수 */
  readonly count: number;
  /** 보낼 내용 (비우지 않는다) */
  payloads(): AttachmentPayload[];
  /** 한 번에 보내기에는 너무 큰가 — 크면 나눠 보내라고 알린다 */
  readonly tooLarge: boolean;
  clear(): void;
  /** target 에 끌어다 놓기·붙여 넣기를 건다. 돌려주는 함수로 푼다 */
  bind(target: HTMLElement, pasteTarget: HTMLElement): () => void;
  dispose(): void;
}

const KIND_LABEL: Record<AttachKind, string> = {
  text: '글', hwp: '한글 문서', pdf: 'PDF', docx: 'Word', xlsx: '스프레드시트', pptx: '발표 자료', image: '그림',
};

function kindIcon(kind: AttachKind | null | undefined): IconName {
  return kind === 'image' ? 'image' : kind === 'xlsx' ? 'sheet' : 'file';
}

/** 파일 칩 하나 (입력 상자와 보낸 메시지에서 같이 쓴다) */
function chip(name: string, kind: AttachKind | null, detail: string): HTMLElement {
  const node = document.createElement('span');
  node.className = 'dg-file-chip';
  const label = document.createElement('span');
  label.className = 'dg-file-name';
  label.textContent = name;
  const sub = document.createElement('span');
  sub.className = 'dg-file-sub';
  sub.textContent = detail;
  node.append(icon(kindIcon(kind), 14), label, sub);
  node.title = `${name}${detail ? ` · ${detail}` : ''}`;
  return node;
}

/** 보낸 메시지에 붙는 파일 칩 줄 (대화 기록에서 다시 그릴 때도 쓴다) */
export function sentFileChips(files: ReadonlyArray<{ name: string; kind?: string; size?: number }>): HTMLElement {
  const row = document.createElement('div');
  row.className = 'dg-user-files';
  row.setAttribute('role', 'list');
  row.setAttribute('aria-label', `붙인 파일 ${files.length}개`);
  for (const f of files) {
    const kind = (f.kind && f.kind in KIND_LABEL ? f.kind : null) as AttachKind | null;
    const node = chip(f.name, kind, kind ? KIND_LABEL[kind] : '');
    node.setAttribute('role', 'listitem');
    row.append(node);
  }
  return row;
}

export function createAttachTray(opts: {
  read: AttachReader;
  /** 칩이 바뀔 때 — 보내기 단추 상태를 다시 그린다 */
  onChange(): void;
  /** 받지 못한 파일을 알린다 (한도 초과 등) */
  notify(text: string): void;
}): AttachTray {
  const root = document.createElement('div');
  root.className = 'dg-attach-row';
  root.hidden = true;
  root.setAttribute('role', 'list');
  root.setAttribute('aria-label', '붙인 파일');
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = ATTACH_ACCEPT;
  input.hidden = true;
  input.tabIndex = -1;
  input.className = 'dg-attach-input';
  input.setAttribute('aria-hidden', 'true');
  let drafts: Draft[] = [];
  let seq = 0;
  let disposed = false;

  const render = (): void => {
    root.hidden = drafts.length === 0;
    root.replaceChildren(input, ...drafts.map((d) => {
      const detail = d.status === 'reading' ? '읽는 중…' : d.status === 'error' ? (d.error ?? '읽지 못했습니다')
        : [d.kind ? KIND_LABEL[d.kind] : '', formatBytes(d.size)].filter(Boolean).join(' · ');
      const node = chip(d.name, d.kind, detail);
      node.dataset.state = d.status;
      node.setAttribute('role', 'listitem');
      if (d.status === 'error') node.setAttribute('aria-invalid', 'true');
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'dg-file-remove';
      remove.setAttribute('aria-label', `${d.name} 빼기`);
      remove.title = '빼기';
      remove.append(icon('close', 11, 2.2));
      remove.addEventListener('click', () => {
        drafts = drafts.filter((x) => x !== d);
        render();
        opts.onChange();
      });
      node.append(remove);
      return node;
    }));
    if (drafts.length === 0) root.append(input);
  };

  const add = (files: Iterable<File>): void => {
    const list = [...files];
    if (list.length === 0) return;
    const room = ATTACH_LIMITS.files - drafts.filter((d) => d.status !== 'error').length;
    if (list.length > room) {
      opts.notify(`한 번에 파일 ${ATTACH_LIMITS.files}개까지 붙일 수 있습니다. ${Math.max(0, room)}개만 올렸습니다.`);
    }
    for (const file of list.slice(0, Math.max(0, room))) {
      const draft: Draft = { id: ++seq, name: file.name || '붙여 넣은 파일', size: file.size, kind: null, status: 'reading' };
      try { draft.kind = classifyFile(file.name, file.type); } catch { draft.kind = null; }
      drafts.push(draft);
      void opts.read(file).then((payload) => {
        draft.payload = payload;
        draft.kind = payload.kind;
        draft.status = 'ready';
      }, (error: unknown) => {
        draft.status = 'error';
        draft.error = error instanceof AttachError ? error.message : '읽지 못했습니다';
        if (!(error instanceof AttachError)) console.warn('[doogle] 첨부 읽기 실패', file.name, error);
      }).finally(() => {
        if (disposed || !drafts.includes(draft)) return;
        render();
        opts.onChange();
      });
    }
    render();
    opts.onChange();
  };

  input.addEventListener('change', () => {
    add(input.files ?? []);
    input.value = ''; // 같은 파일을 다시 고를 수 있게
  });
  render();

  return {
    root,
    pick: () => input.click(),
    add,
    get busy() { return drafts.some((d) => d.status === 'reading'); },
    get count() { return drafts.filter((d) => d.status === 'ready').length; },
    payloads: () => drafts.filter((d) => d.status === 'ready' && d.payload).map((d) => d.payload as AttachmentPayload),
    get tooLarge() {
      return payloadBytes(drafts.filter((d) => d.status === 'ready' && d.payload).map((d) => d.payload as AttachmentPayload)) > ATTACH_LIMITS.messageBytes;
    },
    clear(): void {
      drafts = [];
      render();
      opts.onChange();
    },
    bind(target: HTMLElement, pasteTarget: HTMLElement): () => void {
      const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
      let depth = 0;
      const over = (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      };
      const enter = (e: DragEvent) => {
        if (!hasFiles(e)) return;
        depth++;
        target.classList.add('dg-drop-on');
      };
      const leave = (e: DragEvent) => {
        if (!hasFiles(e)) return;
        depth = Math.max(0, depth - 1);
        if (depth === 0) target.classList.remove('dg-drop-on');
      };
      const drop = (e: DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.stopPropagation();
        depth = 0;
        target.classList.remove('dg-drop-on');
        add(e.dataTransfer?.files ?? []);
      };
      const paste = (e: ClipboardEvent) => {
        const files = [...(e.clipboardData?.files ?? [])];
        if (files.length === 0) return; // 글 붙여 넣기는 그대로 둔다
        e.preventDefault();
        add(files);
      };
      target.addEventListener('dragover', over);
      target.addEventListener('dragenter', enter);
      target.addEventListener('dragleave', leave);
      target.addEventListener('drop', drop);
      pasteTarget.addEventListener('paste', paste);
      return () => {
        target.removeEventListener('dragover', over);
        target.removeEventListener('dragenter', enter);
        target.removeEventListener('dragleave', leave);
        target.removeEventListener('drop', drop);
        pasteTarget.removeEventListener('paste', paste);
        target.classList.remove('dg-drop-on');
      };
    },
    dispose(): void {
      disposed = true;
      drafts = [];
    },
  };
}
