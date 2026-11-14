/**
 * 카드 만들기용 표 꺼내기 — 첨부 읽기(attach-read)가 만든 글에서 가장 큰 표 하나를 줄·칸으로 나눈다.
 *
 *  - 엑셀·한글·Word 의 표는 `| 칸 | 칸 |` 줄로 온다(attach-core rowLine). 이어진 줄 묶음 중 가장 긴 것을 고른다.
 *  - 그런 줄이 없으면 탭(TSV) → 쉼표(CSV) 순서로 나눈다.
 *
 * AI 에게는 앞 몇 줄만 보내고(`tablePreview`), 나머지 값은 AI 가 정한 열 짝(columns)대로 화면에서 채운다.
 */

/** `| a | b |` 한 줄 → ['a', 'b'] (rowLine 이 바꾼 ¦ 는 | 로, " / " 는 줄바꿈으로 되돌리지 않는다) */
function pipeCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split('|').map((c) => c.trim().replace(/¦/g, '|'));
}

function splitDelimited(line: string, sep: string): string[] {
  const out: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell.trim() === '') { quoted = true; cell = ''; }
    else if (ch === sep) { out.push(cell.trim()); cell = ''; }
    else cell += ch;
  }
  out.push(cell.trim());
  return out;
}

/** 글에서 가장 큰 표 하나 (없으면 빈 배열). 모든 줄은 가장 넓은 줄의 칸 수로 맞춘다 */
export function extractTable(text: string): string[][] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let best: string[][] = [];
  let run: string[][] = [];
  const close = () => {
    if (run.length > best.length) best = run;
    run = [];
  };
  for (const line of lines) {
    if (/^\s*\|.*\|\s*$/.test(line)) run.push(pipeCells(line));
    else close();
  }
  close();
  if (best.length === 0) {
    const body = lines.filter((l) => l.trim() !== '' && !/^##\s/.test(l));
    const sep = body.some((l) => l.includes('\t')) ? '\t' : body.some((l) => l.includes(',')) ? ',' : '';
    if (!sep) return [];
    best = body.map((l) => splitDelimited(l, sep));
  }
  const width = Math.max(0, ...best.map((r) => r.length));
  return best
    .map((r) => [...r, ...Array.from({ length: width - r.length }, () => '')])
    .filter((r) => r.some((c) => c !== ''));
}

/** AI 에게 보낼 앞부분 — 줄 번호(0부터)를 붙인 처음 `rows` 줄과 전체 줄 수 */
export function tablePreview(table: string[][], rows = 4): string {
  const head = table.slice(0, rows).map((r, i) => `${i}: ${r.map((c) => JSON.stringify(c)).join(', ')}`);
  return [`전체 ${table.length}줄, ${table[0]?.length ?? 0}칸. 앞 ${head.length}줄:`, ...head].join('\n');
}

/** AI 가 정한 열 짝으로 표 → 카드 줄. columns[i] = 카드 i번째 항목이 올 원본 열(0부터, -1 이면 빈칸) */
export function mapRows(table: string[][], dataStart: number, columns: number[]): string[][] {
  return table.slice(Math.max(0, dataStart))
    .map((r) => columns.map((c) => (c >= 0 && c < r.length ? r[c] : '')))
    .filter((r) => r.some((c) => c.trim() !== ''));
}
