/**
 * 검토 대기 중인 에이전트 변경이 있을 때의 저장·닫기 확인(UI_AUDIT 3.11).
 *
 * 에이전트 변경은 검토 전에도 이미 문서에 들어가 있다(라이브 스테이징). 그래서 "저장"만 누르면
 * 검토하지 않은 변경이 그대로 파일에 들어간다 — 이 대화상자는 그 사실을 본문에 쓰고, 먼저 적용할지
 * 거절할지 고르게 한다. upstream 대화상자는 고치지 않고 같은 `ModalDialog` 틀만 쓴다.
 */
import { ModalDialog } from '@/ui/dialog';

/** apply = 변경 적용하고 저장, reject = 변경 거절하고 저장, keep = 검토 대기 그대로 저장 */
export type ReviewSaveChoice = 'apply' | 'reject' | 'keep' | 'discard' | 'cancel';

export interface ReviewSaveDialogOptions {
  fileName: string;
  pendingCount: number;
  /** 닫기·업데이트 앞(저장 안 함 단추 있음) / 저장 앞('그대로 저장' + 다시 묻지 않음) */
  purpose: 'leave' | 'save';
  /** 에이전트 변경 뒤에 사용자가 직접 고친 내용이 있다(거절하면 함께 되돌아간다) */
  userEdits?: boolean;
}

class ReviewSaveDialog extends ModalDialog {
  private resolve!: (value: ReviewSaveChoice) => void;
  private dontAsk: HTMLInputElement | null = null;

  constructor(private readonly options: ReviewSaveDialogOptions) {
    super(options.purpose === 'leave' ? '저장하지 않은 변경' : '검토 대기 중인 변경', 460);
  }

  get dontAskAgain(): boolean {
    return !!this.dontAsk?.checked;
  }

  protected createBody(): HTMLElement {
    const body = document.createElement('div');
    body.className = 'dg-review-save-body';
    const lead = document.createElement('p');
    const name = this.options.fileName || '이 문서';
    lead.textContent = this.options.purpose === 'leave'
      ? `'${name}'에 저장하지 않은 변경이 있습니다.`
      : `'${name}'을(를) 저장하기 전에 확인해 주세요.`;
    const warn = document.createElement('p');
    warn.className = 'dg-review-save-warn';
    warn.textContent = `검토 대기 중인 에이전트 변경 ${this.options.pendingCount}건이 문서에 포함돼 있습니다. `
      + '그대로 저장하면 검토하지 않은 변경도 파일에 들어갑니다.';
    body.append(lead, warn);
    if (this.options.userEdits) {
      const edits = document.createElement('p');
      edits.className = 'dg-review-save-warn';
      edits.textContent = '그 뒤에 직접 고친 내용이 섞여 있습니다. [변경 거절하고 저장]을 고르면 직접 고친 내용도 함께 되돌아갑니다.';
      body.append(edits);
    }
    if (this.options.purpose === 'save') {
      const label = document.createElement('label');
      label.className = 'dg-review-save-dontask';
      this.dontAsk = document.createElement('input');
      this.dontAsk.type = 'checkbox';
      label.append(this.dontAsk, ' 다시 묻지 않고 검토 대기 그대로 저장');
      body.append(label);
    }
    return body;
  }

  protected onConfirm(): void {
    this.resolve('apply');
  }

  override hide(): void {
    this.resolve('cancel');
    super.hide();
  }

  showAsync(): Promise<ReviewSaveChoice> {
    return new Promise((resolve) => {
      let resolved = false;
      this.resolve = (value) => {
        if (!resolved) { resolved = true; resolve(value); }
      };
      super.show();
      const footer = this.dialog.querySelector('.dialog-footer');
      const applyBtn = this.dialog.querySelector('.dialog-btn-primary') as HTMLButtonElement | null;
      const cancelBtn = footer?.querySelector('.dialog-btn:not(.dialog-btn-primary)') as HTMLButtonElement | null;
      if (applyBtn) applyBtn.textContent = '변경 적용하고 저장';
      if (cancelBtn) cancelBtn.textContent = '취소';
      const extra = (label: string, choice: ReviewSaveChoice) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'dialog-btn';
        b.textContent = label;
        b.addEventListener('click', () => { this.resolve(choice); super.hide(); });
        footer?.insertBefore(b, cancelBtn ?? null);
      };
      extra('변경 거절하고 저장', 'reject');
      if (this.options.purpose === 'leave') extra('저장 안 함', 'discard');
      else extra('그대로 저장', 'keep');
    });
  }
}

export async function showReviewSaveDialog(options: ReviewSaveDialogOptions): Promise<{ choice: ReviewSaveChoice; dontAskAgain: boolean }> {
  const dialog = new ReviewSaveDialog(options);
  const choice = await dialog.showAsync();
  return { choice, dontAskAgain: dialog.dontAskAgain };
}
