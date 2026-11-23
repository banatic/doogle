import { ModalDialog } from './dialog';
import type { WasmBridge } from '@/core/wasm-bridge';
import type { EventBus } from '@/core/event-bus';
import type { CommandServices } from '@/command/types';
import { applyThroughRouter } from './dialog-apply';
import type { DocumentPosition } from '@/core/types';

import { t } from '../i18n/index.ts';
const HWPUNIT_PER_MM = 7200 / 25.4;

function hwpunitToMm(hu: number): number {
  return Math.round(hu / HWPUNIT_PER_MM * 10) / 10;
}

function mmToHwpunit(mm: number): number {
  return Math.round(mm * HWPUNIT_PER_MM);
}

const LABEL_MIN_W = '80px';

/** 적용 범위 — 한/글 [다단 설정]의 "적용 범위". 값은 엔진 `applyColumnDef` 의 scope. */
export const COLUMN_APPLY_SCOPES = [
  { value: 0, key: 'dialog.columnSettings.scope.current' },
  { value: 1, key: 'dialog.columnSettings.scope.new' },
  { value: 2, key: 'dialog.columnSettings.scope.section' },
  { value: 3, key: 'dialog.columnSettings.scope.document' },
] as const;

export class ColumnSettingsDialog extends ModalDialog {
  private wasm: WasmBridge;
  private eventBus: EventBus;
  private sectionIdx: number;

  private countInput!: HTMLInputElement;
  private typeSelect!: HTMLSelectElement;
  private sameWidthCheck!: HTMLInputElement;
  private spacingInput!: HTMLInputElement;
  private scopeSelect!: HTMLSelectElement;
  /** 캐럿 자리(본문 좌표). 표 안이면 표를 지닌 본문 문단의 처음으로 본다. */
  private paraIdx: number;
  private charOffset: number;

  constructor(
    wasm: WasmBridge,
    eventBus: EventBus,
    sectionIdx: number,
    private services?: CommandServices,
    position?: Pick<DocumentPosition, 'paragraphIndex' | 'charOffset' | 'parentParaIndex'>,
  ) {
    super(t('dialog.columnSettings.mmToHwpunit.title'), 360);
    this.wasm = wasm;
    this.eventBus = eventBus;
    this.sectionIdx = sectionIdx;
    const inCell = position?.parentParaIndex !== undefined;
    this.paraIdx = (inCell ? position?.parentParaIndex : position?.paragraphIndex) ?? 0;
    this.charOffset = inCell ? 0 : (position?.charOffset ?? 0);
  }

  show(): void {
    super.show();
    this.populateFields();
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');

    const addRow = (label: string): HTMLElement => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;margin-bottom:10px;gap:8px;';
      const lbl = document.createElement('label');
      lbl.textContent = label;
      lbl.style.cssText = `min-width:${LABEL_MIN_W};font-size:13px;`;
      row.appendChild(lbl);
      body.appendChild(row);
      return row;
    };

    // 단 수
    const countRow = addRow(t('dialog.columnSettings.addRow.label'));
    this.countInput = document.createElement('input');
    this.countInput.type = 'number';
    this.countInput.min = '1';
    this.countInput.max = '8';
    this.countInput.style.cssText = 'width:60px;padding:4px 6px;font-size:13px;';
    countRow.appendChild(this.countInput);

    // 단 종류
    const typeRow = addRow(t('dialog.columnSettings.addRow.label.x2ec5ae'));
    this.typeSelect = document.createElement('select');
    this.typeSelect.style.cssText = 'width:120px;padding:4px;font-size:13px;';
    for (const [val, text] of [['0', t('dialog.columnSettings.createBody.label')], ['1', t('dialog.columnSettings.createBody.label.x88b36c')], ['2', t('dialog.columnSettings.createBody.label.xb86927')]]) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = text;
      this.typeSelect.appendChild(opt);
    }
    typeRow.appendChild(this.typeSelect);

    // 너비 동일
    const sameRow = addRow(t('dialog.columnSettings.addRow.label.x1ce391'));
    this.sameWidthCheck = document.createElement('input');
    this.sameWidthCheck.type = 'checkbox';
    sameRow.appendChild(this.sameWidthCheck);

    // 단 간격
    const spacingRow = addRow(t('dialog.columnSettings.addRow.label.x35c51a'));
    this.spacingInput = document.createElement('input');
    this.spacingInput.type = 'number';
    this.spacingInput.min = '0';
    this.spacingInput.step = '0.5';
    this.spacingInput.style.cssText = 'width:80px;padding:4px 6px;font-size:13px;';
    spacingRow.appendChild(this.spacingInput);

    // 적용 범위
    const scopeRow = addRow(t('dialog.columnSettings.scope.label'));
    this.scopeSelect = document.createElement('select');
    this.scopeSelect.style.cssText = 'width:120px;padding:4px;font-size:13px;';
    for (const scope of COLUMN_APPLY_SCOPES) {
      const opt = document.createElement('option');
      opt.value = String(scope.value);
      opt.textContent = t(scope.key);
      this.scopeSelect.appendChild(opt);
    }
    scopeRow.appendChild(this.scopeSelect);

    return body;
  }

  private populateFields(): void {
    try {
      const def = this.wasm.getColumnDefAt(this.sectionIdx, this.paraIdx);
      this.countInput.value = String(Math.max(def.columnCount, 1));
      this.typeSelect.value = String(def.columnType);
      this.sameWidthCheck.checked = def.sameWidth;
      this.spacingInput.value = String(hwpunitToMm(def.spacing));
    } catch {
      this.countInput.value = '1';
      this.typeSelect.value = '0';
      this.sameWidthCheck.checked = true;
      this.spacingInput.value = '8';
    }
    this.scopeSelect.value = '0';
  }

  protected onConfirm(): boolean {
    const count = Math.max(1, Math.min(8, parseInt(this.countInput.value, 10) || 1));
    const type = Math.max(0, Math.min(2, parseInt(this.typeSelect.value, 10) || 0));
    const sameWidth = this.sameWidthCheck.checked ? 1 : 0;
    const spacingHu = Math.max(0, Math.min(32767, mmToHwpunit(parseFloat(this.spacingInput.value) || 0)));
    const scope = Math.max(0, Math.min(3, parseInt(this.scopeSelect.value, 10) || 0));
    // [다단 설정 이관] snapshot 으로 라우팅(#2077 동형). services 미주입 시 직접 적용 fallback.
    const apply = (): { section: number; para: number; charOffset: number } | null => {
      const raw = this.wasm.applyColumnDef(
        this.sectionIdx, this.paraIdx, this.charOffset, scope, count, type, sameWidth, spacingHu,
      );
      try {
        const res = JSON.parse(raw);
        if (res && typeof res.para === 'number') {
          return { section: res.section ?? this.sectionIdx, para: res.para, charOffset: res.charOffset ?? 0 };
        }
      } catch { /* 옛 엔진 응답 */ }
      return null;
    };
    return applyThroughRouter({
      services: this.services,
      label: 'ColumnSettingsDialog',
      operationType: 'columnSettings',
      operation: (ih) => {
        const caret = apply();
        // 새 다단으로는 문단을 나눌 수 있다 — 캐럿을 새 다단의 처음으로 옮긴다.
        if (scope === 1 && caret) {
          return { sectionIndex: caret.section, paragraphIndex: caret.para, charOffset: caret.charOffset };
        }
        return ih.getCursorPosition();
      },
      fallback: () => { apply(); this.eventBus.emit('document-changed'); },
    });
  }
}
