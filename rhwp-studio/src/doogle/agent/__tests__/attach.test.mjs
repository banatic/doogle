// 참고 파일(첨부) 읽기 — 형식 판별, 인코딩, zip, docx · xlsx · pptx, 엔진 문서 글.
// 실행: cd rhwp-studio && node --test src/doogle/agent/__tests__/attach.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import {
  ATTACH_LIMITS, AttachError, classifyFile, clipText, decodeText, docxText, excelDate, extensionOf, fitWithin, formatBytes,
  officeText, pptxText, unzip, wordXmlText, xlsxText, xmlText,
} from '../../attach/attach-core.ts';
import { engineDocumentText } from '../../attach/doc-text.ts';
import { Engine } from '../engine-adapter.ts';

const enc = (s) => new TextEncoder().encode(s);

// ─── 시험용 zip 쓰기 ─────────────────────────────────────
// streamed=true 면 로컬 머리의 크기를 0 으로 두고 data descriptor 를 붙인다(스트리밍으로 만든 zip 흉내).
function zip(entries, { streamed = false, comment = '' } = {}) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (buf) => { chunks.push(buf); offset += buf.length; };
  for (const [name, content, opts = {}] of entries) {
    const raw = Buffer.from(typeof content === 'string' ? enc(content) : content);
    const stored = opts.store === true;
    const data = stored ? raw : deflateRawSync(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const flags = (streamed ? 8 : 0) | 0x800 | (opts.encrypted ? 1 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(stored ? 0 : (opts.method ?? 8), 8);
    local.writeUInt32LE(streamed ? 0 : data.length, 18);
    local.writeUInt32LE(streamed ? 0 : raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const at = offset;
    push(local); push(nameBuf); push(data);
    if (streamed) {
      const dd = Buffer.alloc(16);
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(data.length, 8);
      dd.writeUInt32LE(raw.length, 12);
      push(dd);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6);
    c.writeUInt16LE(flags, 8);
    c.writeUInt16LE(stored ? 0 : (opts.method ?? 8), 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(at, 42);
    central.push(Buffer.concat([c, nameBuf]));
  }
  const dirStart = offset;
  for (const c of central) push(c);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - dirStart, 12);
  end.writeUInt32LE(dirStart, 16);
  end.writeUInt16LE(Buffer.byteLength(comment), 20);
  push(end);
  if (comment) push(Buffer.from(comment));
  return new Uint8Array(Buffer.concat(chunks));
}

// ─── 형식 판별·작은 도우미 ───────────────────────────────

test('attach: file kinds by extension and mime; unreadable formats say what to do', () => {
  assert.equal(extensionOf('보고서.최종.HWPX'), 'hwpx');
  assert.equal(extensionOf('.gitignore'), '');
  for (const [name, kind] of [['a.hwp', 'hwp'], ['A.HWPX', 'hwp'], ['규정.pdf', 'pdf'], ['a.docx', 'docx'], ['a.xlsx', 'xlsx'],
    ['a.xlsm', 'xlsx'], ['a.pptx', 'pptx'], ['a.PNG', 'image'], ['a.jpeg', 'image'], ['메모.txt', 'text'], ['data.csv', 'text'], ['a.md', 'text']]) {
    assert.equal(classifyFile(name), kind, name);
  }
  assert.equal(classifyFile('붙여 넣은 그림', 'image/png'), 'image');
  assert.equal(classifyFile('noext', 'text/plain'), 'text');
  assert.equal(classifyFile('scan', 'application/pdf'), 'pdf');
  assert.throws(() => classifyFile('옛문서.doc'), (e) => e instanceof AttachError && e.code === 'UNSUPPORTED_TYPE' && /\.docx 로 저장/.test(e.message));
  assert.throws(() => classifyFile('a.xls'), /\.xlsx 로 저장/);
  assert.throws(() => classifyFile('a.zip'), /\.zip 파일은 읽지 못합니다/);
  assert.throws(() => classifyFile('noext'), /이 파일 형식은 읽지 못합니다/);
});

test('attach: sizes, clipping, image fit', () => {
  assert.equal(formatBytes(512), '512B');
  assert.equal(formatBytes(1536), '1.5KB');
  assert.equal(formatBytes(250 * 1024), '250KB');
  assert.equal(formatBytes(3.24 * 1024 * 1024), '3.2MB');
  assert.equal(formatBytes(24 * 1024 * 1024), '24MB');
  assert.deepEqual(clipText('가나다', 2), { text: '가나', truncated: true });
  assert.deepEqual(clipText('가나다', 3), { text: '가나다', truncated: false });
  assert.deepEqual(fitWithin(4000, 3000, 1568), { width: 1568, height: 1176 });
  assert.deepEqual(fitWithin(800, 3200, 1600), { width: 400, height: 1600 });
  assert.deepEqual(fitWithin(640, 480, 1568), { width: 640, height: 480 }, 'never upscales');
});

test('attach: text decoding — UTF-8, BOM, UTF-16, EUC-KR csv from Excel; binary is refused', () => {
  assert.deepEqual(decodeText(enc('가나다\r\nabc')), { text: '가나다\nabc', encoding: 'utf-8' });
  assert.deepEqual(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('머리')])), { text: '머리', encoding: 'utf-8' });
  const utf16 = new Uint8Array([0xff, 0xfe, ...new Uint8Array(new Uint16Array([...'한글 A'].map((c) => c.charCodeAt(0))).buffer)]);
  assert.deepEqual(decodeText(utf16), { text: '한글 A', encoding: 'utf-16le' });
  // "이름,부서\n홍길동,총무과" in EUC-KR
  const euckr = new Uint8Array([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0xba, 0xce, 0xbc, 0xad, 0x0a, 0xc8, 0xab, 0xb1, 0xe6, 0xb5, 0xbf, 0x2c, 0xc3, 0xd1, 0xb9, 0xab, 0xb0, 0xfa]);
  assert.deepEqual(decodeText(euckr), { text: '이름,부서\n홍길동,총무과', encoding: 'euc-kr' });
  assert.throws(() => decodeText(new Uint8Array([0x50, 0x4b, 0, 0, 0, 0, 0, 0, 1, 2, 3, 0, 0, 0])), (e) => e.code === 'NOT_TEXT');
});

test('attach: xml entities', () => {
  assert.equal(xmlText('A &amp; B &lt;c&gt; &quot;q&quot; &apos;s&apos; &#44032; &#xB098; &unknown;'), 'A & B <c> "q" \'s\' 가 나 &unknown;');
  assert.equal(xmlText('plain'), 'plain');
});

// ─── zip ─────────────────────────────────────────────────

test('attach: unzip reads deflated, stored and streamed (data descriptor) entries, only the wanted ones', async () => {
  const big = '줄 '.repeat(20000);
  for (const streamed of [false, true]) {
    const bytes = zip([['a.txt', '첫째'], ['dir/b.xml', big], ['c.bin', new Uint8Array([1, 2, 3]), { store: true }]], { streamed, comment: streamed ? '주석이 붙은 zip' : '' });
    const got = await unzip(bytes, (n) => n !== 'a.txt');
    assert.deepEqual([...got.keys()], ['dir/b.xml', 'c.bin']);
    assert.equal(new TextDecoder().decode(got.get('dir/b.xml')), big);
    assert.deepEqual([...got.get('c.bin')], [1, 2, 3]);
  }
});

test('attach: unzip refuses what it cannot read, with a reason', async () => {
  await assert.rejects(unzip(enc('이건 zip 이 아니다'), () => true), (e) => e instanceof AttachError && e.code === 'BAD_ZIP');
  await assert.rejects(unzip(zip([['a.txt', 'x', { encrypted: true }]]), () => true), (e) => e.code === 'ENCRYPTED' && /암호/.test(e.message));
  await assert.rejects(unzip(zip([['a.txt', 'x', { method: 12 }]]), () => true), /지원하지 않는 압축/);
  const cut = zip([['a.txt', '가'.repeat(5000)]]);
  await assert.rejects(unzip(cut.subarray(0, cut.length - 40), () => true), (e) => e.code === 'BAD_ZIP');
  // 깨진 압축 데이터
  const broken = zip([['a.txt', '가'.repeat(5000)]]);
  broken.fill(0xff, 40, 60);
  await assert.rejects(unzip(broken, () => true), (e) => e.code === 'BAD_ZIP');
});

// ─── docx ────────────────────────────────────────────────

const W = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
const P = (...runs) => `<w:p><w:pPr><w:jc w:val="left"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${runs.join('')}</w:p>`;
const R = (text) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
const TC = (...paras) => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${paras.join('')}</w:tc>`;
const TR = (...cells) => `<w:tr><w:trPr><w:trHeight w:val="300"/></w:trPr>${cells.join('')}</w:tr>`;
const TBL = (...rows) => `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid>${rows.join('')}</w:tbl>`;

test('attach: docx — paragraphs, runs, tabs, breaks, entities, tables, nested tables, tracked deletions', () => {
  const xml = W([
    P(R('교원 자율연수비 '), R('지원 계획')),
    '<w:p/>',
    P(R('1. 목적'), '<w:r><w:tab/></w:r>', R('연수 참여 &amp; 역량 &lt;강화&gt;')),
    P(R('첫 줄'), '<w:r><w:br/></w:r>', R('둘째 줄')),
    P('<w:del><w:r><w:delText>지운 글</w:delText></w:r></w:del>', '<w:ins><w:r><w:t>넣은 글</w:t></w:r></w:ins>'),
    TBL(
      TR(TC(P(R('구분'))), TC(P(R('금액')))),
      TR(TC(P(R('연수비')), P(R('(1인당)'))), TC(P(R('150,000원')))),
      TR(TC(P(R('안쪽')), TBL(TR(TC(P(R('가'))), TC(P(R('나')))))), TC('<w:p/>')),
    ),
    P(R('끝.')),
  ].join(''));
  assert.equal(wordXmlText(xml), [
    '교원 자율연수비 지원 계획',
    '',
    '1. 목적\t연수 참여 & 역량 <강화>',
    '첫 줄',
    '둘째 줄',
    '넣은 글',
    '',
    '| 구분 | 금액 |',
    '| 연수비 / (1인당) | 150,000원 |',
    '| 안쪽 / 가 · 나 |  |',
    '',
    '끝.',
  ].join('\n'));
});

test('attach: docx file — body plus footnotes; a zip without a body is refused', async () => {
  const foot = '<w:footnotes xmlns:w="x"><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:r><w:t>출처: 교육부</w:t></w:r></w:p></w:footnote></w:footnotes>';
  const bytes = zip([['[Content_Types].xml', '<Types/>'], ['word/document.xml', W(P(R('본문')))], ['word/footnotes.xml', foot], ['word/media/image1.png', new Uint8Array(2000)]]);
  const r = await officeText('docx', bytes);
  assert.equal(r.text, '본문\n\n[각주]\n1) 출처: 교육부');
  await assert.rejects(officeText('docx', zip([['other.xml', '<x/>']])), (e) => e.code === 'BAD_FILE');
  assert.throws(() => docxText(new Map()), /본문을 찾지 못했습니다/);
});

// ─── xlsx ────────────────────────────────────────────────

test('attach: excel dates', () => {
  assert.equal(excelDate(46337), '2026-11-11');
  assert.equal(excelDate(46337.5), '2026-11-11 12:00');
  assert.equal(excelDate(0.75), '18:00');
  assert.equal(excelDate(1), '1899-12-31');
  assert.equal(excelDate(44875, true), '2026-11-11', '1904 date system');
});

test('attach: xlsx — shared and inline strings, numbers, dates by style, booleans, gaps, several sheets in workbook order', () => {
  const files = new Map(Object.entries({
    'xl/workbook.xml': '<workbook xmlns:r="r"><workbookPr/><sheets><sheet name="예산 &amp; 집행" sheetId="1" r:id="rId2"/><sheet name="빈 시트" sheetId="2" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet2.xml"/><Relationship Id="rId2" Type="t" Target="/xl/worksheets/sheet1.xml"/><Relationship Id="rId3" Type="t" Target="styles.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>항목</t></si><si><r><t>연수</t></r><r><t xml:space="preserve">비 </t></r><rPh sb="0" eb="2"><t>ヨミ</t></rPh></si><si><t>기간</t></si><si/></sst>',
    'xl/styles.xml': '<styleSheet><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy&quot;년&quot; m&quot;월&quot; d&quot;일&quot;"/><numFmt numFmtId="165" formatCode="#,##0&quot;원&quot;"/><numFmt numFmtId="166" formatCode="0.0%"/></numFmts><cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="9"/><xf numFmtId="166"/></cellXfs></styleSheet>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
      + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>비고 | 메모</t></is></c></row>'
      + '<row r="2"></row>'
      + '<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3" s="1"><v>46337</v></c><c r="C3" s="3"><v>150000</v></c><c r="D3" t="b"><v>1</v></c></row>'
      + '<row r="4"><c r="A4" t="str"><f>A1&amp;"x"</f><v>식 결과</v></c><c r="B4" s="2"><v>46357.25</v></c><c r="C4"><v>0.30000000000000004</v></c><c r="E4" t="e"><v>#DIV/0!</v></c></row>'
      + '<row r="5"><c r="A5" s="1"/><c r="B5"><f>SUM(C3:C4)</f></c></row>'
      // 백분율 서식(내장 9번 · 직접 만든 0.0%)은 화면에 보이는 대로 읽는다
      + '<row r="6"><c r="A6" s="4"><v>0.25</v></c><c r="B6" s="5"><v>0.125</v></c><c r="C6" s="4"><v>1.1</v></c></row>'
      + '</sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData/></worksheet>',
  }).map(([k, v]) => [k, enc(v)]));
  const r = xlsxText(files);
  assert.equal(r.sheets, 2);
  assert.equal(r.truncated, false);
  assert.equal(r.text, [
    '## 시트: 예산 & 집행',
    '',
    '| 항목 | 기간 |  | 비고 ¦ 메모 |',
    '| 연수비 | 2026-11-11 | 150000 | TRUE |',
    '| 식 결과 | 2026-12-01 06:00 | 0.3 |  | #DIV/0! |',
    '| 25% | 12.5% | 110% |',
    '',
    '## 시트: 빈 시트 (빈 시트)',
  ].join('\n'));
});

test('attach: xlsx written by a real library (openpyxl) reads back', async () => {
  const bytes = new Uint8Array(readFileSync(new URL('./fixtures/attach-sample.xlsx', import.meta.url)));
  const r = await officeText('xlsx', bytes);
  assert.equal(r.meta.sheets, 3);
  assert.match(r.text, /^## 시트: 예산\n\n\| 항목 \| 금액 \| 집행일 \| 비율 \|\n\| 연수비 \| 150000 \| 2026-07-20 \| 25% \|\n\| 교재비 \| 32000\.5 \| 2026-08-14 09:30 \| 0\.3 \|/);
  assert.match(r.text, /## 시트: 담당자\n\n\| 이름 \| 부서 \| 비고 \|\n\| 홍길동 \| 총무과 \|\n\| 김철수 \| 교무부 \| 인수인계 & 확인 <필수> \|/);
  assert.match(r.text, /## 시트: 빈 시트 \(빈 시트\)$/);
});

test('attach: xlsx row cap marks the result as truncated', () => {
  const rows = Array.from({ length: ATTACH_LIMITS.sheetRows + 5 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
  const files = new Map([
    ['xl/workbook.xml', enc('<workbook><sheets><sheet name="큰 시트" sheetId="1" r:id="rId1"/></sheets></workbook>')],
    ['xl/worksheets/sheet1.xml', enc(`<worksheet><sheetData>${rows}</sheetData></worksheet>`)],
  ]);
  const r = xlsxText(files);
  assert.equal(r.truncated, true);
  assert.equal(r.text.split('\n').filter((l) => l.startsWith('| ')).length, ATTACH_LIMITS.sheetRows);
  assert.match(r.text, /5000행까지만 읽었습니다/);
  assert.throws(() => xlsxText(new Map()), /시트 목록을 찾지 못했습니다/);
});

// ─── pptx ────────────────────────────────────────────────

test('attach: pptx — slides in presentation order (not file order), paragraphs, line breaks, tables', () => {
  const slide = (...paras) => `<p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>${paras.join('')}</p:spTree></p:cSld></p:sld>`;
  const sp = (...texts) => `<p:sp><p:txBody><a:bodyPr/>${texts.map((t) => `<a:p><a:r><a:rPr lang="ko-KR"/><a:t>${t}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp>`;
  const files = new Map(Object.entries({
    'ppt/presentation.xml': '<p:presentation xmlns:r="r"><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/><p:sldId id="258" r:id="rId4"/></p:sldIdLst></p:presentation>',
    'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Target="slides/slide1.xml"/><Relationship Id="rId3" Target="slides/slide2.xml"/><Relationship Id="rId4" Target="slides/slide3.xml"/></Relationships>',
    'ppt/slides/slide1.xml': slide(sp('둘째 장', '내용 &amp; 요약')),
    'ppt/slides/slide2.xml': slide(sp('첫 장 제목'), '<p:sp><p:txBody><a:p><a:r><a:t>윗줄</a:t></a:r><a:br/><a:r><a:t>아랫줄</a:t></a:r></a:p><a:p><a:endParaRPr/></a:p></p:txBody></p:sp>'),
    'ppt/slides/slide3.xml': slide('<p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblGrid/><a:tr h="1"><a:tc><a:txBody><a:p><a:r><a:t>항목</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>값</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>', sp('표 아래 글')),
  }).map(([k, v]) => [k, enc(v)]));
  const r = pptxText(files);
  assert.equal(r.slides, 3);
  assert.equal(r.text, '## 슬라이드 1\n첫 장 제목\n윗줄\n아랫줄\n\n## 슬라이드 2\n둘째 장\n내용 & 요약\n\n## 슬라이드 3\n| 항목 | 값 |\n표 아래 글');
  // 순서 정보가 없으면 파일 번호 순 (10 이 2 뒤에 온다)
  const loose = new Map([['ppt/slides/slide10.xml', enc(slide(sp('열째')))], ['ppt/slides/slide2.xml', enc(slide(sp('둘째')))], ['ppt/slides/slide1.xml', enc(slide())]]);
  assert.equal(pptxText(loose).text, '## 슬라이드 1 (글 없음)\n\n## 슬라이드 2\n둘째\n\n## 슬라이드 3\n열째');
  assert.throws(() => pptxText(new Map()), /슬라이드를 찾지 못했습니다/);
});

// ─── 엔진 문서 글 (hwp · hwpx · pdf) ─────────────────────

/** 본문 문단 + 표(칸마다 문단들, 칸 안의 표)를 가진 작은 문서 흉내 — Engine 이 부르는 메서드만 */
class RefDoc {
  constructor(paras, tables = [], perPage = 0) { this.paras = paras; this.tables = tables; this.perPage = perPage; this.freed = false; }
  getSectionCount() { return 1; }
  getParagraphCount() { return this.paras.length; }
  pageCount() { return this.perPage ? Math.ceil(this.paras.length / this.perPage) : 1; }
  getParagraphLength(_s, p) { return [...this.paras[p]].length; }
  getTextRange(_s, p, off, n) { return [...this.paras[p]].slice(off, off + n).join(''); }
  getObjects() { return JSON.stringify(this.tables.map((t, i) => ({ para: t.para, controlIndex: t.control ?? i, kind: 'table' })).concat([{ para: 0, controlIndex: 9, kind: 'picture' }])); }
  getPageTextLayout(page) { return JSON.stringify({ runs: [{ secIdx: 0, paraIdx: page * this.perPage, charStart: 0 }] }); }
  #table(path) {
    const entries = JSON.parse(path);
    let t = this.tables.find((x) => x.para === this.lastPara && (x.control ?? 0) === entries[0].controlIndex);
    for (let i = 1; i < entries.length; i++) t = t.cells[entries[i - 1].cellIndex].nested[0];
    return { t, last: entries[entries.length - 1] };
  }
  getTableDimensions(_s, para, control) { const t = this.tables.find((x) => x.para === para && (x.control ?? 0) === control); return JSON.stringify({ rowCount: t.rows, colCount: t.cols, cellCount: t.cells.length }); }
  getTableDimensionsByPath(_s, para, path) { this.lastPara = para; const { t } = this.#table(path); return JSON.stringify({ rowCount: t.rows, colCount: t.cols, cellCount: t.cells.length }); }
  getCellInfoByPath(_s, para, path) { this.lastPara = para; const { t, last } = this.#table(path); const c = t.cells[last.cellIndex]; return JSON.stringify({ row: c.row, col: c.col, rowSpan: 1, colSpan: 1 }); }
  getCellInfo(_s, para, control, cellIdx) { const t = this.tables.find((x) => x.para === para && (x.control ?? 0) === control); const c = t.cells[cellIdx]; return JSON.stringify({ row: c.row, col: c.col, rowSpan: 1, colSpan: 1 }); }
  getCellParagraphCountByPath(_s, para, path) { this.lastPara = para; const { t, last } = this.#table(path); return t.cells[last.cellIndex].paras.length; }
  getCellParagraphLengthByPath(_s, para, path) { this.lastPara = para; const { t, last } = this.#table(path); return [...t.cells[last.cellIndex].paras[last.cellParaIndex]].length; }
  getTextInCellByPath(_s, para, path, off, n) { this.lastPara = para; const { t, last } = this.#table(path); return [...t.cells[last.cellIndex].paras[last.cellParaIndex]].slice(off, off + n).join(''); }
  // 칸 안의 표 — 엔진은 그 표의 첫 칸까지의 경로(cellPath)를 준다
  getTableControlsInSelection(_s, para, path) {
    this.lastPara = para;
    const { t, last } = this.#table(path);
    const nested = t.cells[last.cellIndex].nested ?? [];
    return JSON.stringify(nested.map((_, i) => ({
      cellPath: [...JSON.parse(path).slice(0, -1), { ...last, cellParaIndex: 0 }, { controlIndex: i, cellIndex: 0, cellParaIndex: 0 }],
    })));
  }
}

test('attach: engine document text — paragraphs, tables as rows, no live-document addresses', () => {
  const cell = (row, col, ...paras) => ({ row, col, paras });
  const doc = new RefDoc(
    ['교원 자율연수비 지원 신청서', '', '', '위와 같이 신청합니다.'],
    [{ para: 2, rows: 2, cols: 2, cells: [cell(0, 1, '직위'), cell(0, 0, '소속'), cell(1, 0, '○○고등학교', '(본교)'), { ...cell(1, 1, '교사'), nested: [{ rows: 1, cols: 2, cells: [cell(0, 0, '가'), cell(0, 1, '나')] }] }] }],
  );
  const r = engineDocumentText(new Engine(doc), 10_000);
  assert.equal(r.truncated, false);
  assert.equal(r.pages, 1);
  // 표는 행·열 순서대로(칸 번호 순서가 아니라), 칸 안의 문단은 " / ", 칸 안의 표는 한 줄로 접힌다
  assert.equal(r.text, [
    '교원 자율연수비 지원 신청서',
    '',
    '| 소속 | 직위 |',
    '| ○○고등학교 / (본교) | 교사 / [표: 가 · 나] |',
    '',
    '위와 같이 신청합니다.',
  ].join('\n'));
  assert.doesNotMatch(r.text, /\bs0 p\d|\bcellIdx|\[\d+ B\]/, '열린 문서용 주소가 없어야 한다');
});

test('attach: engine document text — page marks on multi-page documents and a hard character cap', () => {
  const doc = new RefDoc(Array.from({ length: 6 }, (_, i) => `${i + 1}번째 문단입니다`), [], 2);
  const engine = new Engine(doc);
  const r = engineDocumentText(engine, 10_000);
  assert.equal(r.pages, 3);
  assert.equal(r.text, '[1쪽]\n1번째 문단입니다\n2번째 문단입니다\n\n[2쪽]\n3번째 문단입니다\n4번째 문단입니다\n\n[3쪽]\n5번째 문단입니다\n6번째 문단입니다');
  const cut = engineDocumentText(new Engine(doc), 30);
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length <= 30, `${cut.text.length}`);
  assert.ok(cut.text.startsWith('[1쪽]\n1번째 문단입니다'));
});

// ─── PDF: 쪽 배치에서 글 읽기 ────────────────────────────

test('attach: pdf page layout — runs become lines in reading order; wide gaps become columns, tall gaps paragraphs', async () => {
  const { linesFromRuns, pagedDocumentText } = await import('../../attach/doc-text.ts');
  const run = (text, x, y, w = text.length * 8, h = 12) => ({ text, x, y, w, h });
  const runs = [
    run('지원', 137, 100.4), run('교원', 60, 100), run(' ', 76, 100, 8), run('자율연수비', 84, 100, 48), // one line, out of order, slightly different y
    run('제1조(목적)', 60, 116), run('이 규정은', 126, 116), // next line (1.3× line height), small gap → a space
    run('구분', 60, 200), run('금액', 300, 200), // far apart → columns
    run('연수비', 60, 216), run('150,000원', 300, 216),
    run('', 0, 0), { text: '좌표 없음' },
  ];
  assert.equal(linesFromRuns(runs), '교원 자율연수비 지원\n제1조(목적) 이 규정은\n\n구분\t금액\n연수비\t150,000원');
  assert.equal(linesFromRuns([]), '');

  // 쪽마다 [N쪽], 글이 없는 쪽은 emptyPages 로 (스캔본 → 그림으로 보낸다)
  const pages = [[run('첫 쪽의 글이 충분히 길게 있습니다', 60, 100)], [], [run('셋째 쪽에도 글이 넉넉하게 있습니다', 60, 100)]];
  const doc = { pageCount: () => pages.length, getPageTextLayout: (p) => JSON.stringify({ runs: pages[p] }) };
  const r = pagedDocumentText(new Engine(doc), 10_000);
  assert.equal(r.text, '[1쪽]\n첫 쪽의 글이 충분히 길게 있습니다\n\n[3쪽]\n셋째 쪽에도 글이 넉넉하게 있습니다');
  assert.deepEqual([r.pages, r.emptyPages, r.truncated], [3, [1], false]);
  const cut = pagedDocumentText(new Engine(doc), 20);
  assert.equal(cut.truncated, true);
  assert.ok(cut.text.length <= 20);
  // 한 쪽짜리는 쪽 표시를 붙이지 않는다
  const one = { pageCount: () => 1, getPageTextLayout: () => JSON.stringify({ runs: pages[0] }) };
  assert.equal(pagedDocumentText(new Engine(one), 10_000).text, '첫 쪽의 글이 충분히 길게 있습니다');
});

test('attach: one message cannot carry more than the hub accepts — the size estimate counts text and pictures', async () => {
  const { payloadBytes } = await import('../../attach/attach-core.ts');
  assert.equal(payloadBytes([]), 0);
  const text = { name: 'a.txt', kind: 'text', mime: '', size: 1, text: '가'.repeat(1000) };
  const pic = { name: 'b.png', kind: 'image', mime: '', size: 1, images: [{ mimeType: 'image/png', base64: 'A'.repeat(5000) }] };
  assert.equal(payloadBytes([text]), 3400);
  assert.equal(payloadBytes([text, pic]), 3400 + 400 + 5120);
  // ten files at the per-file text cap stay under the message cap; a dozen large pictures do not
  const full = Array.from({ length: ATTACH_LIMITS.files }, () => ({ ...text, text: 'x'.repeat(ATTACH_LIMITS.textChars) }));
  assert.ok(payloadBytes(full) < ATTACH_LIMITS.messageBytes);
  const heavy = Array.from({ length: 8 }, () => ({ ...pic, images: [{ mimeType: 'image/png', base64: 'A'.repeat(7_000_000) }] }));
  assert.ok(payloadBytes(heavy) > ATTACH_LIMITS.messageBytes);
});

// ─── 점검에서 나온 결함 (조작된 파일 · 실제 Office 가 쓰는 꼴) ──────────

/** 중앙 디렉터리의 크기를 마음대로 적는 zip — 항목마다 [이름, 내용, 적어 둘 크기] */
function lyingZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const push = (buf) => { chunks.push(buf); offset += buf.length; };
  /** 같은 압축 조각을 여러 항목이 함께 가리키게 한다 */
  const blobs = new Map();
  for (const [name, raw, declared] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    let blob = blobs.get(raw);
    if (!blob) {
      const data = deflateRawSync(Buffer.from(raw));
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(8, 8);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(declared ?? raw.length, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      blob = { at: offset, packed: data.length };
      push(local); push(nameBuf); push(data);
      blobs.set(raw, blob);
    }
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(blob.packed, 20);
    c.writeUInt32LE(declared ?? raw.length, 24);
    c.writeUInt16LE(nameBuf.length, 28);
    c.writeUInt32LE(blob.at, 42);
    central.push(Buffer.concat([c, nameBuf]));
  }
  const dirStart = offset;
  for (const c of central) push(c);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - dirStart, 12);
  end.writeUInt32LE(dirStart, 16);
  push(end);
  return new Uint8Array(Buffer.concat(chunks));
}

test('attach: a zip entry that inflates past its declared size is stopped while inflating, not after', async () => {
  // 1KB 라고 적혀 있지만 120MB 로 풀린다 — 다 풀기 전에 멈춰야 한다
  const bomb = lyingZip([['xl/worksheets/sheet1.xml', Buffer.alloc(120 * 1024 * 1024, 0x41), 1024]]);
  const before = process.memoryUsage().rss;
  const started = performance.now();
  await assert.rejects(unzip(bomb, () => true), (e) => e instanceof AttachError && e.code === 'BAD_ZIP' && /크기가 맞지 않습니다/.test(e.message));
  assert.ok(performance.now() - started < 1500, `took ${Math.round(performance.now() - started)}ms`);
  assert.ok(process.memoryUsage().rss - before < 40 * 1024 * 1024, 'the inflated bytes must not have been buffered');
  // 저장(무압축) 항목도 적어 둔 크기와 다르면 거절
  const stored = zip([['a.txt', 'abcdef', { store: true }]]);
  stored[stored.length - 22 - 46 - 5 + 24] ^= 0x01; // 중앙 디렉터리의 푼 크기를 한 비트 바꾼다
  await assert.rejects(unzip(stored, () => true), (e) => e.code === 'BAD_ZIP');
});

test('attach: unzip has a total budget and an entry-count cap — many entries cannot share one blob to fill memory', async () => {
  const sheet = Buffer.alloc(20 * 1024 * 1024, 0x20);
  // 20MB 로 풀리는 조각 하나를 항목 12개가 가리킨다 (합 240MB > 한도 160MB)
  const shared = lyingZip(Array.from({ length: 12 }, (_, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheet]));
  assert.ok(shared.length < 100 * 1024, `zip is only ${shared.length} bytes`);
  await assert.rejects(unzip(shared, () => true), (e) => e.code === 'TOO_LARGE');
  // 항목 수 한도
  const tiny = Buffer.from('<a/>');
  const many = lyingZip(Array.from({ length: ATTACH_LIMITS.unzipEntries + 1 }, (_, i) => [`ppt/slides/slide${i + 1}.xml`, tiny]));
  await assert.rejects(unzip(many, () => true), (e) => e.code === 'TOO_LARGE');
  // 한도 안이면 그대로 읽는다. 같은 이름이 또 나오면 처음 것만
  const ok = await unzip(lyingZip([['a.xml', tiny], ['b.xml', tiny], ['a.xml', Buffer.from('<other/>')]]), () => true);
  assert.deepEqual([...ok.keys()], ['a.xml', 'b.xml']);
  assert.equal(new TextDecoder().decode(ok.get('a.xml')), '<a/>');
});

test('attach: hostile XML (opening tags that never close) is read in linear time', () => {
  const timed = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
  const wb = enc('<workbook><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>');
  const n = 400_000;
  const cases = {
    'xlsx <row> never closed': () => xlsxText(new Map([['xl/workbook.xml', wb], ['xl/worksheets/sheet1.xml', enc(`<worksheet><sheetData>${'<row>'.repeat(n)}</sheetData></worksheet>`)]])),
    'xlsx <c> never closed': () => xlsxText(new Map([['xl/workbook.xml', wb], ['xl/worksheets/sheet1.xml', enc(`<worksheet><sheetData><row>${'<c r="A1">'.repeat(n)}`)]])),
    'xlsx <si> never closed': () => xlsxText(new Map([['xl/workbook.xml', wb], ['xl/sharedStrings.xml', enc(`<sst>${'<si><rPh>'.repeat(n)}`)], ['xl/worksheets/sheet1.xml', enc('<worksheet/>')]])),
    'xlsx tag never ends': () => xlsxText(new Map([['xl/workbook.xml', wb], ['xl/worksheets/sheet1.xml', enc(`<worksheet><sheetData>${'<row r="1" '.repeat(n)}`)]])),
    'docx <w:p> never closed': () => wordXmlText('<w:p><w:r><w:t>'.repeat(n)),
    'docx footnotes never closed': () => docxText(new Map([['word/document.xml', enc('<w:p/>')], ['word/footnotes.xml', enc('<w:footnote>'.repeat(n))]])),
    'pptx <a:p>/<a:tbl> never closed': () => pptxText(new Map([['ppt/slides/slide1.xml', enc('<a:tbl><a:tr><a:tc><a:p>'.repeat(n))]])),
  };
  for (const [label, run] of Object.entries(cases)) {
    const ms = timed(run);
    // 길이에 비례하면 수십 ms 다. 제곱이면 이 크기에서 분 단위가 된다
    assert.ok(ms < 2500, `${label}: ${Math.round(ms)}ms`);
  }
});

test('attach: docx text boxes are read once (mc:Fallback repeats mc:Choice), and field codes are not text', () => {
  const box = '<w:txbxContent><w:p><w:r><w:t>상자 글</w:t></w:r></w:p></w:txbxContent>';
  const xml = W(`<w:p><w:r><w:t>앞</w:t></w:r><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>${box}</w:drawing></mc:Choice>`
    + `<mc:Fallback><w:pict>${box}</w:pict></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>뒤</w:t></w:r></w:p>`
    + '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:t>3</w:t></w:r><!-- <w:t>주석 속 글</w:t> --></w:p>');
  assert.equal(wordXmlText(xml), '앞\n상자 글\n뒤\n3');
});

test('attach: xlsx with namespace-prefixed tags (Open XML SDK / ClosedXML) and an empty shared string in the middle', () => {
  const files = new Map(Object.entries({
    'xl/workbook.xml': '<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets><x:sheet name="내보내기" sheetId="1" r:id="R1"/></x:sheets></x:workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="R1" Target="worksheets/data.xml"/></Relationships>',
    // 가운데의 빈 항목(<x:si/>)도 번호 하나를 차지한다 — 뒤 항목이 밀리면 안 된다
    'xl/sharedStrings.xml': '<x:sst xmlns:x="m"><x:si><x:t>이름</x:t></x:si><x:si/><x:si><x:t>부서</x:t></x:si><x:si><x:t>홍길동</x:t></x:si></x:sst>',
    'xl/worksheets/data.xml': '<x:worksheet xmlns:x="m"><x:sheetData>'
      + '<x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>2</x:v></x:c><x:c r="C1" t="s"><x:v>1</x:v></x:c></x:row>'
      + '<x:row r="2"><x:c r="A2" t="s"><x:v>3</x:v></x:c><x:c r="B2" t="inlineStr"><x:is><x:t>총무과</x:t></x:is></x:c><x:c r="C2"><x:v>42</x:v></x:c></x:row>'
      + '</x:sheetData></x:worksheet>',
  }).map(([k, v]) => [k, enc(v)]));
  assert.deepEqual(xlsxText(files), { text: '## 시트: 내보내기\n\n| 이름 | 부서 |\n| 홍길동 | 총무과 | 42 |', sheets: 1, truncated: false });
});

test('attach: a date-styled cell that cannot be a date keeps its number', () => {
  assert.equal(excelDate(1e12), '1000000000000');
  assert.equal(excelDate(-3), '-3');
  assert.equal(excelDate(Number.NaN), 'NaN');
  assert.equal(excelDate(2958465), '9999-12-31');
});
