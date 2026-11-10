/**
 * 두글 리본의 선언 데이터 — 탭 → 묶음 → 단추.
 *
 * 모든 `cmd` 는 upstream 커맨드 레지스트리에 **이미 있는** id 다(`src/command/commands/*.ts`,
 * `index.html #menu-bar data-cmd`). 실행은 `window.rhwpStudio.automation.execute` 로 메뉴·툴바·
 * 단축키와 같은 디스패처를 탄다. 레지스트리에 없는 id 는 그리는 시점에 빠진다(`shell/ribbon.ts`).
 *
 * `slot` 은 upstream 서식 도구 모음(#style-bar)·기본 도구 상자(#icon-toolbar)의 **실제 요소**를
 * 리본으로 옮겨 쓰는 자리다. 선택 상태 반영·적용 로직은 upstream `Toolbar` 가 그대로 맡는다.
 */
import type { EditorContext } from '@/command/types';

export type ItemSize = 'lg' | 'sm' | 'ico';

export interface CmdItem {
  kind: 'cmd';
  id: string;
  label: string;
  icon: string;
  size: ItemSize;
  params?: Record<string, unknown>;
  /** 큰 단추 아이콘 색(시안 F: 표=accent, 그림=초록, 도형=보라, 누름틀=aiText) */
  iconColor?: string;
  /** `ico` 단추에서 아이콘 대신 보일 글자(예: 가²) */
  text?: string;
  textClass?: string;
  /** 눌림 상태 — 컨텍스트 또는 upstream 요소의 active 클래스에서 읽는다 */
  pressed?: (ctx: EditorContext) => boolean;
  /** 간소화 리본(한 줄 48px)에도 보이는가 */
  simple?: boolean;
}

export interface SlotItem {
  kind: 'slot';
  slot: SlotName;
  simple?: boolean;
}

/**
 * 셸 자신의 동작(커맨드 레지스트리 밖).
 *  - palette: 명령 입력 열기
 *  - review-*: 검토 대기 중인 에이전트 변경 탐색·결정(review/state.ts 의 reviewStore)
 *  - ribbon-collapse / ribbon-simple: 리본 표시 방식
 */
export type ShellAction =
  | 'palette'
  | 'review-prev' | 'review-next' | 'review-accept-all' | 'review-reject-all'
  | 'ribbon-collapse' | 'ribbon-simple';

export interface ActionItem {
  kind: 'action';
  action: ShellAction;
  label: string;
  icon: string;
  size: ItemSize;
  tone?: 'ai';
  simple?: boolean;
}

export interface MenuEntry { id: string; label: string; params?: Record<string, unknown> }

export interface MenuItem {
  kind: 'menu';
  label: string;
  icon: string;
  size: ItemSize;
  text?: string;
  entries: MenuEntry[];
  simple?: boolean;
}

export type RibbonItem = CmdItem | SlotItem | ActionItem | MenuItem;

export interface RibbonGroup {
  id: string;
  caption: string;
  /** 좁아질 때 낮은 값부터 '더보기'로 접힌다. slot 을 품은 묶음은 접지 않는다(Infinity). */
  priority: number;
  /** 두 줄 배치(글자·문단 모양). 없으면 `items` 를 흐름 배치 — 작은 단추는 3개씩 세로로 쌓는다. */
  rows?: RibbonItem[][];
  items?: RibbonItem[];
}

export interface RibbonTab {
  id: string;
  label: string;
  /** '더보기' 에 펼칠 upstream 메뉴(`#menu-bar [data-menu]`) */
  menuId?: string;
  groups: RibbonGroup[];
  /** 커서가 표 안일 때만 보이는 상황 탭 */
  contextual?: 'table';
  /** 키팁 — Alt/F10 뒤 누르는 두벌식 한 글자(같은 자리의 영문 키도 받는다) */
  key?: string;
}

/** slot 이름 → upstream 요소 찾기. `move` 는 실제로 옮길 바깥 요소다. */
export const SLOT_SELECTORS = {
  'style-name': { find: '#style-name' },
  'font-name': { find: '#font-name' },
  'font-size': { find: '#font-size', move: '.sb-size-group' },
  bold: { find: '#btn-bold' },
  italic: { find: '#btn-italic' },
  underline: { find: '#btn-underline' },
  strike: { find: '#btn-strike' },
  charfx: { find: '#charfx-dropdown' },
  'text-color': { find: '#btn-text-color', move: '.sb-color-wrap' },
  highlight: { find: '#highlight-dropdown' },
  'align-justify': { find: '#btn-align-justify' },
  'align-left': { find: '#btn-align-left' },
  'align-center': { find: '#btn-align-center' },
  'align-right': { find: '#btn-align-right' },
  'align-distribute': { find: '#btn-align-distribute' },
  bullet: { find: '#tb-bullet' },
  numbering: { find: '#tb-numbering' },
  'line-spacing': { find: '#linespacing-group' },
} as const satisfies Record<string, { find: string; move?: string }>;

export type SlotName = keyof typeof SLOT_SELECTORS;

const cmd = (id: string, label: string, icon: string, size: ItemSize, extra: Partial<CmdItem> = {}): CmdItem =>
  ({ kind: 'cmd', id, label, icon, size, ...extra });
const slot = (name: SlotName): SlotItem => ({ kind: 'slot', slot: name });
const activeIn = (selector: string) => () => !!document.querySelector(`${selector}.active`);

const simple = <T extends RibbonItem>(item: T): T => ({ ...item, simple: true });
const action = (a: ShellAction, label: string, icon: string, size: ItemSize, extra: Partial<ActionItem> = {}): ActionItem =>
  ({ kind: 'action', action: a, label, icon, size, ...extra });

export const RIBBON_TABS: RibbonTab[] = [
  {
    id: 'edit',
    label: '편집',
    menuId: 'edit',
    key: 'ㅎ',
    groups: [
      {
        id: 'clipboard', caption: '클립보드', priority: 6,
        items: [
          cmd('edit:paste', '붙이기', 'paste', 'lg', { iconColor: 'var(--dg-accent)' }),
          cmd('edit:cut', '오려 두기', 'cut', 'sm'),
          cmd('edit:copy', '복사하기', 'copy', 'sm'),
          cmd('edit:format-copy', '모양 복사', 'brush', 'sm'),
        ],
      },
      {
        id: 'char', caption: '글자 모양', priority: Infinity,
        rows: [
          [simple(slot('style-name')), simple(slot('font-name')), simple(slot('font-size'))],
          [
            simple(slot('bold')), simple(slot('italic')), simple(slot('underline')), simple(slot('strike')),
            cmd('format:superscript', '위 첨자', '', 'ico', {
              text: '가²', pressed: activeIn('#charfx-menu [data-format="superscript"]'),
            }),
            simple(slot('text-color')), slot('highlight'), slot('charfx'),
            {
              kind: 'menu', label: '장평·자간', icon: 'ratio', size: 'ico', text: '↔가',
              entries: [
                { id: 'format:char-ratio-increase', label: '장평 넓게' },
                { id: 'format:char-ratio-decrease', label: '장평 좁게' },
                { id: 'format:char-spacing-increase', label: '자간 넓게' },
                { id: 'format:char-spacing-decrease', label: '자간 좁게' },
                { id: 'format:char-shape', label: '글자 모양…' },
              ],
            },
          ],
        ],
      },
      {
        id: 'para', caption: '문단 모양', priority: Infinity,
        rows: [
          [simple(slot('align-justify')), simple(slot('align-left')), simple(slot('align-center')), simple(slot('align-right')), slot('align-distribute')],
          [
            slot('bullet'), slot('numbering'), slot('line-spacing'),
            cmd('format:level-decrease', '한 수준 감소', 'outdent', 'ico'),
            cmd('format:level-increase', '한 수준 증가', 'indent', 'ico'),
          ],
        ],
      },
      {
        id: 'insert', caption: '입력', priority: 3,
        items: [
          cmd('table:create', '표', 'table', 'lg', { iconColor: 'var(--dg-accent)', simple: true }),
          cmd('insert:image', '그림', 'image', 'lg', { iconColor: 'var(--dg-icon-image, #059669)', simple: true }),
          cmd('insert:shape', '도형', 'shape', 'lg', { iconColor: 'var(--dg-icon-shape, #7C3AED)' }),
          cmd('insert:field', '누름틀', 'field', 'lg', { iconColor: 'var(--dg-ai-text)' }),
        ],
      },
      {
        id: 'find', caption: '찾기', priority: 4,
        items: [
          cmd('edit:find', '찾기', 'find', 'lg', { iconColor: 'var(--dg-text2)', simple: true }),
          cmd('edit:find-replace', '바꾸기', 'replace', 'lg', { iconColor: 'var(--dg-text2)' }),
        ],
      },
    ],
  },
  {
    id: 'view',
    label: '보기',
    menuId: 'view',
    key: 'ㅂ',
    groups: [
      {
        id: 'zoom', caption: '확대/축소', priority: 5,
        items: [
          cmd('view:zoom-dialog', '배율', 'find', 'lg', { iconColor: 'var(--dg-accent)' }),
          cmd('view:zoom-fit-page', '쪽 맞춤', 'fitPage', 'lg'),
          cmd('view:zoom-fit-width', '폭 맞춤', 'fitWidth', 'lg'),
          cmd('view:zoom-in', '확대', 'zoomIn', 'sm'),
          cmd('view:zoom-out', '축소', 'zoomOut', 'sm'),
          cmd('view:zoom-100', '100%', 'cols1', 'sm'),
        ],
      },
      {
        id: 'marks', caption: '표시', priority: 4,
        items: [
          cmd('view:ctrl-mark', '조판 부호', 'ctrlMark', 'lg', { pressed: (c) => c.showControlCodes }),
          cmd('view:para-mark', '문단 부호', 'pilcrow', 'lg', { pressed: (c) => c.showParagraphMarks }),
          cmd('view:border-transparent', '투명 선', 'borderDash', 'sm'),
          cmd('view:toggle-clip', '잘림 보기', 'clip', 'sm'),
          cmd('view:toggle-grid', '격자 보기', 'grid', 'sm'),
          cmd('view:grid-settings', '격자 설정', 'gridSettings', 'sm'),
        ],
      },
      {
        id: 'theme', caption: '테마', priority: 3,
        items: [
          cmd('view:theme-system', '시스템 설정 따름', 'monitor', 'sm'),
          cmd('view:theme-light', '밝게', 'sun', 'sm'),
          cmd('view:theme-dark', '어둡게', 'moon', 'sm'),
        ],
      },
      {
        id: 'ribbon', caption: '리본', priority: 2,
        items: [
          action('ribbon-collapse', '리본 접기', 'chevronUp', 'sm'),
          action('ribbon-simple', '간소화 리본', 'ribbonSimple', 'sm'),
        ],
      },
    ],
  },
  {
    id: 'insert',
    label: '입력',
    menuId: 'insert',
    key: 'ㅇ',
    groups: [
      { id: 'table', caption: '표', priority: 8, items: [cmd('table:create', '표', 'table', 'lg', { iconColor: 'var(--dg-accent)' })] },
      {
        id: 'objects', caption: '개체', priority: 7,
        items: [
          cmd('insert:image', '그림', 'image', 'lg', { iconColor: 'var(--dg-icon-image, #059669)' }),
          cmd('insert:shape', '도형', 'shape', 'lg', { iconColor: 'var(--dg-icon-shape, #7C3AED)' }),
          cmd('insert:textbox', '글상자', 'textbox', 'lg'),
          cmd('insert:equation', '수식', 'equation', 'lg'),
        ],
      },
      {
        id: 'refs', caption: '주석·참조', priority: 5,
        items: [
          cmd('insert:footnote', '각주', 'footnote', 'lg'),
          cmd('insert:endnote', '미주', 'endnote', 'lg'),
          cmd('insert:hyperlink', '하이퍼링크', 'link', 'sm'),
          cmd('insert:bookmark', '책갈피', 'bookmark', 'sm'),
          cmd('insert:endnote-shape', '주석 모양', 'paraShape', 'sm'),
        ],
      },
      {
        id: 'etc', caption: '기타', priority: 4,
        items: [
          cmd('insert:field', '누름틀', 'field', 'lg', { iconColor: 'var(--dg-ai-text)' }),
          cmd('insert:symbols', '문자표', 'symbol', 'lg'),
        ],
      },
    ],
  },
  {
    id: 'format',
    label: '서식',
    menuId: 'format',
    key: 'ㅅ',
    groups: [
      {
        id: 'char', caption: '글자', priority: 8,
        items: [
          cmd('format:char-shape', '글자 모양', 'charShape', 'lg', { iconColor: 'var(--dg-accent)' }),
          cmd('format:font-size-increase', '크게', 'fontBigger', 'sm'),
          cmd('format:font-size-decrease', '작게', 'fontSmaller', 'sm'),
          cmd('format:char-ratio-increase', '장평 넓게', 'ratio', 'sm'),
          cmd('format:char-ratio-decrease', '장평 좁게', 'ratio', 'sm'),
          cmd('format:char-spacing-increase', '자간 넓게', 'ratio', 'sm'),
        ],
      },
      {
        id: 'para', caption: '문단', priority: 7,
        items: [
          cmd('format:para-shape', '문단 모양', 'paraShape', 'lg', { iconColor: 'var(--dg-accent)' }),
          cmd('format:line-spacing-increase', '줄 간격 늘림', 'indent', 'sm'),
          cmd('format:line-spacing-decrease', '줄 간격 줄임', 'outdent', 'sm'),
          cmd('format:align-split', '나눔 정렬', 'alignDistribute', 'sm'),
        ],
      },
      {
        id: 'numbering', caption: '번호·글머리', priority: 5,
        items: [
          cmd('format:para-num-shape', '문단 번호 모양', 'numbering', 'lg'),
          cmd('format:bullet-shape', '글머리표 모양', 'bullets', 'lg'),
          cmd('format:level-increase', '한 수준 증가', 'indent', 'sm'),
          cmd('format:level-decrease', '한 수준 감소', 'outdent', 'sm'),
        ],
      },
      { id: 'style', caption: '스타일', priority: 6, items: [cmd('format:style-dialog', '스타일', 'style', 'lg')] },
      { id: 'object', caption: '개체', priority: 3, items: [cmd('format:object-properties', '개체 속성', 'objectProps', 'lg')] },
    ],
  },
  {
    id: 'page',
    label: '쪽',
    menuId: 'page',
    key: 'ㅉ',
    groups: [
      {
        id: 'setup', caption: '쪽 설정', priority: 8,
        items: [
          cmd('page:setup', '편집 용지', 'pageSetup', 'lg', { iconColor: 'var(--dg-accent)' }),
          cmd('page:page-border', '쪽 테두리', 'pageBorder', 'lg'),
        ],
      },
      {
        id: 'hf', caption: '머리말·꼬리말', priority: 7,
        items: [
          cmd('page:header-create', '머리말', 'header', 'lg'),
          cmd('page:footer-create', '꼬리말', 'footer', 'lg'),
          cmd('page:new-page-num', '새 번호로 시작', 'pageNum', 'sm'),
          cmd('page:hide-current', '현재 쪽만 감추기', 'hide', 'sm'),
        ],
      },
      {
        id: 'break', caption: '나누기', priority: 6,
        items: [
          cmd('page:break', '쪽 나누기', 'pageBreak', 'lg'),
          cmd('page:column-break', '단 나누기', 'colBreak', 'lg'),
        ],
      },
      {
        id: 'columns', caption: '단', priority: 5,
        items: [
          cmd('page:col-settings', '다단 설정', 'colSettings', 'lg'),
          cmd('page:col-1', '하나', 'cols1', 'sm'),
          cmd('page:col-2', '둘', 'cols2', 'sm'),
          cmd('page:col-3', '셋', 'cols3', 'sm'),
        ],
      },
      { id: 'section', caption: '구역', priority: 4, items: [cmd('page:section-settings', '구역 설정', 'section', 'lg')] },
    ],
  },
  {
    id: 'security',
    label: '보안',
    key: 'ㄴ',
    groups: [
      {
        id: 'form', caption: '양식', priority: 8,
        items: [cmd('view:form-mode', '양식 모드', 'form', 'lg', { iconColor: 'var(--dg-accent)' })],
      },
      {
        id: 'hide', caption: '감추기', priority: 7,
        items: [
          cmd('page:hide', '감추기', 'hide', 'lg'),
          cmd('page:hide-current', '현재 쪽만 감추기', 'hide', 'sm'),
        ],
      },
    ],
  },
  {
    id: 'review',
    label: '검토',
    key: 'ㄱ',
    groups: [
      {
        // 'AI 도우미' 탭을 합쳤다 — 에이전트가 만든 변경을 문서에서 탐색하고 한꺼번에 결정한다.
        id: 'changes', caption: '에이전트 변경', priority: 9,
        items: [
          action('review-accept-all', '모두 적용', 'checkAll', 'lg', { tone: 'ai' }),
          action('review-reject-all', '모두 거절', 'xAll', 'lg'),
          action('review-prev', '이전 변경', 'prev', 'sm'),
          action('review-next', '다음 변경', 'next', 'sm'),
        ],
      },
      {
        id: 'compare', caption: '비교·이력', priority: 8,
        items: [
          cmd('edit:compare-documents', '문서 비교', 'compare', 'lg', { iconColor: 'var(--dg-accent)' }),
          cmd('edit:document-history', '문서 이력', 'history', 'lg'),
        ],
      },
      {
        id: 'nav', caption: '이동', priority: 6,
        items: [
          cmd('edit:goto', '찾아가기', 'goto', 'sm'),
          cmd('edit:find-again', '다시 찾기', 'findAgain', 'sm'),
          cmd('edit:find', '찾기', 'find', 'sm'),
        ],
      },
    ],
  },
  {
    id: 'tool',
    label: '도구',
    menuId: 'tool',
    key: 'ㄷ',
    groups: [
      {
        id: 'settings', caption: '설정', priority: 8,
        items: [cmd('tool:options', '환경 설정', 'settings', 'lg', { iconColor: 'var(--dg-accent)' })],
      },
      {
        id: 'command', caption: '명령', priority: 7,
        items: [action('palette', '명령 입력', 'command', 'lg')],
      },
    ],
  },
  {
    id: 'table',
    label: '표',
    menuId: 'table',
    contextual: 'table',
    key: 'ㅌ',
    groups: [
      {
        id: 'props', caption: '표', priority: 9,
        items: [
          cmd('table:cell-props', '표/셀 속성', 'table', 'lg', { iconColor: 'var(--dg-accent)' }),
          cmd('table:insert-row-col', '줄/칸 추가', 'rowAdd', 'lg'),
          cmd('table:delete-row-col', '줄/칸 지우기', 'rowDel', 'lg'),
        ],
      },
      {
        id: 'rows', caption: '줄·칸', priority: 6,
        items: [
          cmd('table:insert-row-above', '위에 줄 추가', 'rowAdd', 'sm'),
          cmd('table:insert-row-below', '아래에 줄 추가', 'rowAdd', 'sm'),
          cmd('table:insert-col-left', '왼쪽에 칸 추가', 'rowAdd', 'sm'),
          cmd('table:insert-col-right', '오른쪽에 칸 추가', 'rowAdd', 'sm'),
          cmd('table:delete-row', '줄 지우기', 'rowDel', 'sm'),
          cmd('table:delete-col', '칸 지우기', 'rowDel', 'sm'),
        ],
      },
      {
        id: 'cells', caption: '셀', priority: 7,
        items: [
          cmd('table:cell-merge', '셀 합치기', 'cellMerge', 'lg'),
          cmd('table:cell-split', '셀 나누기', 'cellSplit', 'lg'),
          cmd('table:cell-height-equal', '높이 같게', 'rowAdd', 'sm'),
          cmd('table:cell-width-equal', '너비 같게', 'cols3', 'sm'),
        ],
      },
      {
        id: 'calc', caption: '계산', priority: 4,
        items: [
          cmd('table:block-formula', '계산식', 'sum', 'lg'),
          cmd('table:block-sum', '블록 합계', 'sum', 'sm'),
          cmd('table:block-avg', '블록 평균', 'sum', 'sm'),
          cmd('table:thousand-sep', '1,000 단위 쉼표', 'sum', 'sm'),
        ],
      },
    ],
  },
];
