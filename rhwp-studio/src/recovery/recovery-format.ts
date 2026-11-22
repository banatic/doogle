import type { AutosaveDraft } from './autosave-store.ts';

function baseNameWithoutKnownExtension(fileName: string): string {
  const trimmed = fileName.trim() || '문서.hwp';
  const dot = trimmed.lastIndexOf('.');
  if (dot <= 0) return trimmed;

  const ext = trimmed.slice(dot).toLowerCase();
  if (ext === '.hwp' || ext === '.hwpx' || ext === '.hml') {
    return trimmed.slice(0, dot);
  }
  return trimmed;
}

export function recoveryFileName(fileName: string): string {
  // [doogle] 복구본을 저장하지 않은 채 다시 복구하면 이름이 "X 복구본 복구본 복구본.hwp" 로 불어났다.
  // 이미 붙어 있는 " 복구본" 은 떼고 하나만 붙인다(이름 전체가 "복구본" 이면 그대로 둔다).
  const base = baseNameWithoutKnownExtension(fileName).replace(/(\s*복구본)+$/, '').trim();
  // autosave draft는 exportHwp() 결과이므로 모든 출처의 복구본은 HWP로 생성한다.
  return base ? `${base} 복구본.hwp` : '복구본.hwp';
}

export function formatDraftSavedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '저장 시각 알 수 없음';
  return new Date(timestamp).toLocaleString('ko-KR');
}

export function formatDraftSize(byteLength: number): string {
  if (!Number.isFinite(byteLength) || byteLength < 0) return '크기 알 수 없음';
  if (byteLength < 1024) return `${byteLength} B`;
  const kb = byteLength / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

export function describeDraft(draft: AutosaveDraft): string {
  const format = draft.sourceFormat.toUpperCase();
  const suffix = ['hwpx', 'hml'].includes(draft.sourceFormat.toLowerCase()) ? ' → HWP 복구본' : '';
  return `${draft.protection ? '암호화된 복구본 · ' : ''}${formatDraftSavedAt(draft.savedAt)} · ${formatDraftSize(draft.byteLength)} · ${format}${suffix}`;
}
