// Ported from banatic/rhwp-x (MIT) rhwp/rhwp-studio/src/agent/tool-executor.ts (optAnchor / collectTextMatches / anchorScope)
/**
 * 텍스트 앵커 해석 — find:"정확한 텍스트" / anchor:{text, occurrence, within, position}.
 *
 * 실행 시점에 다시 찾는다: 정확 일치가 늘 이기고, 하나도 없을 때만 탭(⇥)·가로 공백 차이를 풀어
 * 다시 찾는다. 정확히 하나면 적용, 여럿이면 occurrence 가 필요하고, 0개·모호하면 후보 5개와 함께
 * 실패한다. 이 파일은 문서를 직접 읽지 않는다 — `MatchSource` 로 받아 순수 로직으로 남긴다
 * (단위 테스트가 가짜 원천으로 검증한다).
 */
import { invalidArgs, scalarLength, type CellAddr, type CellPathEntry } from './types.ts';

export interface TextMatch {
  sectionIdx: number;
  /** 본문 문단, 셀 매치면 가장 안쪽 셀의 문단 */
  paraIdx: number;
  charOffset: number;
  length: number;
  context: string;
  cell?: CellAddr;
  cellPath?: CellPathEntry[];
  /** 공백 허용 재검색으로 찾았을 때 실제 문서 텍스트 */
  matchedText?: string;
}

/** 검색 대상 문단 하나 (공백 허용 재검색용). */
export interface SourceParagraph {
  sectionIdx: number;
  paraIdx: number;
  text: string;
  cell?: CellAddr;
}

export interface MatchSource {
  /** 정확 일치 — 본문·셀(중첩 포함) 문서 순서. */
  exact(query: string, caseSensitive: boolean): TextMatch[];
  /** 정규식 재검색에 쓸 문단들 — 본문과 표 셀. */
  paragraphs(): Iterable<SourceParagraph>;
}

export interface AnchorScope {
  sectionIdx?: number;
  /** [first, last] 본문 문단 범위 — 셀 매치는 표가 놓인 본문 문단으로 판정한다. */
  paraRange?: [number, number];
  /** 이 최상위 셀(안의 중첩 표까지) 안의 매치만 */
  cell?: { paraIdx: number; controlIdx: number; cellIdx: number };
  /** cell 안에서도 이 중첩 셀 안의 매치만 */
  cellPath?: CellPathEntry[];
  /** cell 과 함께 온 문단 번호 — 그 셀의 문단 범위 */
  cellParaRange?: [number, number];
}

export type AnchorPosition = 'before' | 'after' | 'replace';

export interface ParsedAnchor {
  text: string;
  occurrence?: number;
  position?: AnchorPosition;
  within?: unknown;
  via: 'find' | 'anchor';
}

export interface ResolvedAnchor {
  sectionIdx: number;
  paraIdx: number;
  charOffset: number;
  length: number;
  cell?: CellAddr;
  position?: AnchorPosition;
  /** 문단 번호·셀로 범위를 좁혔는가 — revision 불일치 안내 문구가 갈린다 */
  scoped: boolean;
  via: 'find' | 'anchor';
  matchedText?: string;
}

const CONTEXT_CHARS = 30;
const LINE_BREAK_RE = /[\r\n\u2028\u2029]/;
const OFFSET_KEYS = ['charOffset', 'startCharOffset', 'endCharOffset', 'startOffset', 'endOffset'];

function given(v: unknown): boolean {
  return v !== undefined && v !== null;
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 가로 공백 런(공백·탭·전각 공백·NBSP)을 서로 바꿔 쓸 수 있게 한 패턴. 공백이 없으면 null.
 * 앞뒤 공백은 0개도 허용한다 — 구조 읽기에서 줄 끝 공백이 보이지 않기 때문이다.
 */
export function looseWhitespacePattern(text: string): RegExp | null {
  const trimmed = text.trim();
  if (!/[ \t 　]/.test(text) || trimmed.length === 0) return null;
  const body = trimmed.split(/[ \t 　]+/).map(escapeRegExp).join('[ \\t\\u00a0\\u3000]+');
  return new RegExp(body, 'giu');
}

/** 매치 앞뒤 문맥 (UTF-16 인덱스 기준으로 자른 원문). */
export function contextOf(text: string, utf16Index: number, utf16Length: number): string {
  return text.slice(Math.max(0, utf16Index - CONTEXT_CHARS), Math.min(text.length, utf16Index + utf16Length + CONTEXT_CHARS));
}

/** 정규식 매치를 scalar 오프셋으로 옮겨 모은다. */
export function regexMatches(source: MatchSource, re: RegExp, max: number, scope?: AnchorScope): { matches: TextMatch[]; truncated: boolean } {
  const matches: TextMatch[] = [];
  for (const p of source.paragraphs()) {
    re.lastIndex = 0;
    for (let hit = re.exec(p.text); hit !== null; hit = re.exec(p.text)) {
      if (hit[0].length === 0) { re.lastIndex++; continue; }
      const m: TextMatch = {
        sectionIdx: p.sectionIdx,
        paraIdx: p.paraIdx,
        charOffset: scalarLength(p.text.slice(0, hit.index)),
        length: scalarLength(hit[0]),
        context: contextOf(p.text, hit.index, hit[0].length),
        matchedText: hit[0],
      };
      if (p.cell) {
        m.cell = p.cell;
        if (p.cell.path) m.cellPath = p.cell.path;
      }
      if (!inScope(m, scope)) continue;
      if (matches.length >= max) return { matches, truncated: true };
      matches.push(m);
    }
  }
  return { matches, truncated: false };
}

/** 매치가 검색 범위 안인가. */
export function inScope(m: TextMatch, scope?: AnchorScope): boolean {
  if (!scope) return true;
  if (scope.sectionIdx !== undefined && m.sectionIdx !== scope.sectionIdx) return false;
  const hostPara = m.cell ? m.cell.paraIdx : m.paraIdx;
  if (scope.paraRange && (hostPara < scope.paraRange[0] || hostPara > scope.paraRange[1])) return false;
  if (scope.cell) {
    if (!m.cell) return false;
    if (m.cell.paraIdx !== scope.cell.paraIdx || m.cell.controlIdx !== scope.cell.controlIdx
      || m.cell.cellIdx !== scope.cell.cellIdx) return false;
    const want = scope.cellPath;
    const path = m.cell.path;
    if (want && want.length > 1) {
      if (!path || path.length < want.length) return false;
      for (let i = 0; i < want.length; i++) {
        if (path[i].controlIndex !== want[i].controlIndex || path[i].cellIndex !== want[i].cellIndex) return false;
        if (i < want.length - 1 && path[i].cellParaIndex !== want[i].cellParaIndex) return false;
      }
    }
    if (scope.cellParaRange) {
      const depth = path?.length ?? 1;
      if (depth !== (want?.length ?? 1)) return false;
      if (m.paraIdx < scope.cellParaRange[0] || m.paraIdx > scope.cellParaRange[1]) return false;
    }
  }
  return true;
}

/** find/anchor 인자를 하나의 앵커로 모은다. 둘 다 없으면 null. */
export function parseAnchorArgs(args: Record<string, unknown>): ParsedAnchor | null {
  const find = args['find'];
  const raw = args['anchor'];
  const refiners = (['occurrence', 'position'] as const).filter((key) => given(args[key]));
  if (given(find) && given(raw)) {
    throw invalidArgs('pass find or anchor, not both — find:"text" is the short form of anchor:{text:"text"}');
  }
  if (!given(find) && !given(raw)) {
    if (refiners.length > 0) {
      throw invalidArgs(`${refiners.join('/')} refines a text match — add find:"text", or drop ${refiners.join('/')}`);
    }
    return null;
  }
  const via: 'find' | 'anchor' = given(find) ? 'find' : 'anchor';
  const offsets = OFFSET_KEYS.filter((k) => given(args[k]));
  if (offsets.length > 0) {
    throw invalidArgs(`${offsets.join('/')} and ${via} both place the target — send ${via} (with position/occurrence if needed) or ${offsets.join('/')}, not both`);
  }
  const key = (name: string): string => (via === 'find' ? name : `anchor.${name}`);
  let a: Record<string, unknown>;
  if (via === 'find') {
    if (typeof find !== 'string' || find.length < 1) throw invalidArgs('find must be the exact text to locate (a non-empty string)');
    a = { text: find };
  } else {
    if (typeof raw !== 'string' && (typeof raw !== 'object' || Array.isArray(raw))) {
      throw invalidArgs('anchor must be {text, occurrence?, within?, position?} or the text itself as a string');
    }
    a = typeof raw === 'string' ? { text: raw } : { ...(raw as Record<string, unknown>) };
    const unknown = Object.keys(a).filter((k) => !['text', 'occurrence', 'within', 'position'].includes(k));
    if (unknown.length > 0) throw invalidArgs(`unknown anchor key ${unknown.join('/')} — valid keys: text, occurrence, within, position`);
  }
  for (const name of refiners) {
    if (given(a[name]) && a[name] !== args[name]) {
      throw invalidArgs(`${name} ${JSON.stringify(args[name])} and anchor.${name} ${JSON.stringify(a[name])} disagree — send only one`);
    }
    a[name] = args[name];
  }
  const text = a['text'];
  if (typeof text !== 'string' || text.length < 1) throw invalidArgs('anchor.text must be a non-empty string');
  const occ = a['occurrence'];
  if (given(occ) && (typeof occ !== 'number' || !Number.isSafeInteger(occ))) {
    throw invalidArgs(`${key('occurrence')} must be an integer (got ${JSON.stringify(occ)})`);
  }
  if (typeof occ === 'number' && occ < 1) throw invalidArgs(`${key('occurrence')} is 1-based (must be >= 1)`);
  if (typeof occ === 'number' && occ > 64) throw invalidArgs(`${key('occurrence')} > 64 — narrow the search with paraIdx or cell instead`);
  const pos = a['position'];
  if (given(pos) && pos !== 'before' && pos !== 'after' && pos !== 'replace') {
    throw invalidArgs(`${key('position')} must be "before" | "after" | "replace" (got ${JSON.stringify(pos)})`);
  }
  return {
    text,
    ...(typeof occ === 'number' ? { occurrence: occ } : {}),
    ...(given(pos) ? { position: pos as AnchorPosition } : {}),
    ...(given(a['within']) ? { within: a['within'] } : {}),
    via,
  };
}

function nonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

/** anchor.within + 옆의 sectionIdx/paraIdx/cell/cellPath → 검색 범위. */
export function buildAnchorScope(args: Record<string, unknown>, within: unknown): AnchorScope | undefined {
  const scope: AnchorScope = {};
  if (given(within)) {
    if (typeof within !== 'object' || Array.isArray(within)) {
      throw invalidArgs('anchor.within must be an object {sectionIdx?, paraRange?, cell?}');
    }
    const w = within as Record<string, unknown>;
    const unknown = Object.keys(w).filter((k) => !['sectionIdx', 'paraRange', 'cell'].includes(k));
    if (unknown.length > 0) throw invalidArgs(`unknown anchor.within key ${unknown.join('/')} — valid keys: sectionIdx, paraRange, cell`);
    if (given(w['sectionIdx'])) {
      if (!nonNegInt(w['sectionIdx'])) throw invalidArgs('anchor.within.sectionIdx must be a non-negative integer');
      scope.sectionIdx = w['sectionIdx'];
    }
    if (given(w['paraRange'])) {
      const r = w['paraRange'];
      if (!Array.isArray(r) || r.length !== 2 || !nonNegInt(r[0]) || !nonNegInt(r[1]) || r[1] < r[0]) {
        throw invalidArgs('anchor.within.paraRange must be [firstPara, lastPara] (inclusive, first <= last)');
      }
      scope.paraRange = [r[0], r[1]];
    }
    if (given(w['cell'])) scope.cell = parseCellShape(w['cell'], 'anchor.within.cell');
  }
  if (scope.sectionIdx === undefined && nonNegInt(args['sectionIdx'])) scope.sectionIdx = args['sectionIdx'];
  if (!scope.cell && given(args['cell'])) {
    scope.cell = parseCellShape(args['cell'], 'cell');
    const path = args['cellPath'];
    if (Array.isArray(path) && path.length > 1) scope.cellPath = path as CellPathEntry[];
  }
  const para = args['paraIdx'] ?? args['startParaIdx'];
  if (nonNegInt(para)) {
    const end = nonNegInt(args['endParaIdx']) ? args['endParaIdx'] as number : para;
    const range: [number, number] = [Math.min(para, end), Math.max(para, end)];
    if (scope.cell) scope.cellParaRange = range;
    else if (!scope.paraRange) scope.paraRange = range;
  }
  return Object.keys(scope).length > 0 ? scope : undefined;
}

export function parseCellShape(raw: unknown, name: string): { paraIdx: number; controlIdx: number; cellIdx: number } {
  const c = raw as Record<string, unknown>;
  if (!c || typeof c !== 'object' || !nonNegInt(c['paraIdx']) || !nonNegInt(c['controlIdx']) || !nonNegInt(c['cellIdx'])) {
    throw invalidArgs(`${name} must be {paraIdx, controlIdx, cellIdx} (non-negative integers from a get_structure table line)`);
  }
  return { paraIdx: c['paraIdx'] as number, controlIdx: c['controlIdx'] as number, cellIdx: c['cellIdx'] as number };
}

function truncateForMessage(text: string): string {
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export function anchorCandidates(matches: readonly TextMatch[]): string {
  return matches.slice(0, 5).map((m, i) => {
    const where = m.cell
      ? `s${m.sectionIdx} cell(p${m.cell.paraIdx} c${m.cell.controlIdx} [${m.cell.cellIdx}]) p${m.paraIdx}@${m.charOffset}`
      : `s${m.sectionIdx} p${m.paraIdx}@${m.charOffset}`;
    return `${i + 1}) ${where} "${m.context.replace(/\n/g, '⏎')}"`;
  }).join('; ');
}

/**
 * 앵커를 하나의 매치로 확정한다. batchNote 는 apply_edits 둘째 항목부터의 occurrence 오류 설명이다.
 */
export function resolveAnchor(
  source: MatchSource,
  anchor: ParsedAnchor,
  scope: AnchorScope | undefined,
  batchNote: (text: string, remaining: number) => string = () => '',
): ResolvedAnchor {
  const { text, occurrence, via } = anchor;
  const cap = Math.min(Math.max(occurrence ?? 0, 8), 64);
  const quoted = JSON.stringify(truncateForMessage(text));
  let matches = source.exact(text, false).filter((m) => inScope(m, scope));
  if (matches.length === 0) {
    if (LINE_BREAK_RE.test(text)) {
      throw invalidArgs(`${via} ${quoted} contains a line break, but a match never spans paragraphs — search inside one paragraph; to join two paragraphs, delete_range from the end of one to offset 0 of the next`);
    }
    if (text.includes('⏎')) {
      throw invalidArgs(`${via} ${quoted} contains ⏎, which get_structure prints between cell paragraphs — a match never spans paragraphs, so send one ${via} per paragraph`);
    }
    let search = text;
    if (text.includes('⇥')) {
      search = text.replaceAll('⇥', '\t');
      matches = regexMatches(source, new RegExp(escapeRegExp(search), 'giu'), cap, scope).matches;
    }
    if (matches.length === 0) {
      const pattern = looseWhitespacePattern(search);
      if (pattern) matches = regexMatches(source, pattern, cap, scope).matches;
    }
  }
  if (matches.length === 0) {
    if (scope) {
      const outside = source.exact(text, false);
      if (outside.length > 0) {
        throw invalidArgs(`${via} ${quoted} matched nothing inside its search scope (the paragraph index / cell beside it, or anchor.within) — ${outside.length} hit(s) exist outside it: ${anchorCandidates(outside)}`);
      }
    }
    throw invalidArgs(`${via} ${quoted} matched nothing in the document — check the exact wording with find_text${batchNote(text, 0)}`);
  }
  let picked = matches[0];
  if (occurrence !== undefined) {
    if (occurrence > matches.length) {
      throw invalidArgs(`${via === 'find' ? 'occurrence' : 'anchor.occurrence'} ${occurrence} but only ${matches.length} match(es) for ${quoted}: ${anchorCandidates(matches)}${batchNote(text, matches.length)}`);
    }
    picked = matches[occurrence - 1];
  } else if (matches.length > 1) {
    throw invalidArgs(`${via} ${quoted} is ambiguous — ${matches.length} matches; pass occurrence (1-based) or a narrower paraIdx. Candidates: ${anchorCandidates(matches)}`);
  }
  return {
    sectionIdx: picked.sectionIdx,
    paraIdx: picked.paraIdx,
    charOffset: picked.charOffset,
    length: picked.length,
    ...(picked.cell ? { cell: picked.cell } : {}),
    ...(anchor.position ? { position: anchor.position } : {}),
    scoped: scope?.paraRange !== undefined || scope?.cell !== undefined,
    via,
    ...(picked.matchedText !== undefined && picked.matchedText !== text ? { matchedText: picked.matchedText } : {}),
  };
}

/** 앵커 해석 결과를 쓰기 결과에 싣는 모양. */
export function anchorEcho(m: ResolvedAnchor): Record<string, unknown> {
  const echo: Record<string, unknown> = {
    sectionIdx: m.sectionIdx,
    paraIdx: m.paraIdx,
    charOffset: m.charOffset,
    endCharOffset: m.charOffset + m.length,
  };
  if (m.cell) {
    echo['cell'] = { paraIdx: m.cell.paraIdx, controlIdx: m.cell.controlIdx, cellIdx: m.cell.cellIdx };
    if (m.cell.path) echo['cellPath'] = m.cell.path;
  }
  if (m.matchedText !== undefined) echo['matchedText'] = m.matchedText;
  return echo;
}

/**
 * 엔진 searchAllText 결과 하나를 도구 매치로 옮긴다. 셀 매치의 paraIdx 는 가장 안쪽 셀 문단이고,
 * cell 은 최상위 표 주소(+중첩이면 전체 path)다.
 */
export function matchFromSearchHit(
  hit: {
    sec: number; para: number; charOffset: number; length: number;
    cellContext?: { parentPara: number; ctrlIdx: number; cellIdx: number; cellPara: number };
    cellPath?: CellPathEntry[];
  },
  context: string,
): TextMatch {
  const m: TextMatch = {
    sectionIdx: hit.sec,
    paraIdx: hit.para,
    charOffset: hit.charOffset,
    length: hit.length,
    context,
  };
  const ctx = hit.cellContext;
  const path = hit.cellPath && hit.cellPath.length > 0 ? hit.cellPath : undefined;
  // 엔진은 깊이 1 셀에는 cellContext 를, 중첩 셀에는 cellPath 만 싣는다 — 둘 중 하나만 있어도 셀 매치다.
  // (cellPath 만 올 때 hit.para 는 표가 놓인 본문 문단이다.)
  if (ctx || path) {
    const top = path ? path[0] : { controlIndex: ctx!.ctrlIdx, cellIndex: ctx!.cellIdx, cellParaIndex: ctx!.cellPara };
    m.paraIdx = path ? path[path.length - 1].cellParaIndex : ctx!.cellPara;
    m.cell = {
      paraIdx: ctx ? ctx.parentPara : hit.para,
      controlIdx: top.controlIndex,
      cellIdx: top.cellIndex,
      ...(path && path.length > 1 ? { path } : {}),
    };
    if (path && path.length > 1) m.cellPath = path;
  }
  return m;
}
