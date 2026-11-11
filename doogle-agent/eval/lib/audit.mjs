// 한 턴의 도구 호출 기록을 감사(audit)한다 — 오류·낭비·규칙 위반을 기계적으로 집계하고
// 사람이 읽을 audit.md 를 만든다. 판정은 보수적으로: 여기서 세는 것은 "확인해 볼 신호"다.

const WRITE_RE = /^(insert_|replace_|delete_|move_|apply_|create_|edit_|set_)/;
const isWrite = (name) => WRITE_RE.test(name) || name === 'prepare_engine_edit_session';

function clip(text, n) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n)}… (+${s.length - n})` : s;
}

function compact(value, n = 600) {
  let s;
  try { s = typeof value === 'string' ? value : JSON.stringify(value); } catch { s = String(value); }
  return clip(s ?? '', n);
}

/** 연속 읽기 호출 묶음 중 read_batch 로 합칠 수 있었던 것 (같은 모델 요청에서 병렬로 나온 것은 제외) */
function sequentialReadRuns(calls) {
  const runs = [];
  let run = [];
  for (const c of calls) {
    // 참고 파일 tool(hub 가 처리)은 read_batch 에 담을 수 없다 — 묶을 수 있는 읽기로 세지 않는다
    const read = !isWrite(c.name) && c.name !== 'read_batch' && c.name !== 'render_page' && !/_attachments?$/.test(c.name);
    if (read) { run.push(c); continue; }
    if (run.length >= 2) runs.push(run);
    run = [];
  }
  if (run.length >= 2) runs.push(run);
  // 앞 호출이 끝난 뒤에 시작한 것만 "순차" 로 본다
  return runs.map((r) => r.filter((c, i) => i === 0 || c.t >= r[i - 1].t + (r[i - 1].ms ?? 0))).filter((r) => r.length >= 2);
}

/**
 * @param {{toolCalls: any[], timeline: any[], durationMs: number, usage: any, error: any}} turn
 */
export function auditTurn(turn) {
  const calls = turn.toolCalls ?? [];
  const errors = calls.filter((c) => c.ok === false);
  const byCode = {};
  for (const c of errors) byCode[c.error?.code ?? 'UNKNOWN'] = (byCode[c.error?.code ?? 'UNKNOWN'] ?? 0) + 1;
  const byTool = {};
  for (const c of calls) byTool[c.name] = (byTool[c.name] ?? 0) + 1;
  const writes = calls.filter((c) => isWrite(c.name));
  const singleWrites = writes.filter((c) => c.name !== 'apply_edits' && c.name !== 'apply_engine_edits');
  const findings = [];

  for (const c of errors) {
    findings.push({ level: 'error', seq: c.seq, tool: c.name, code: c.error?.code, message: clip(c.error?.message, 400) });
  }
  // 같은 인자로 같은 읽기를 반복
  const seen = new Map();
  for (const c of calls) {
    if (isWrite(c.name)) { seen.clear(); continue; }
    const key = `${c.name}:${JSON.stringify(c.args)}`;
    if (seen.has(key)) findings.push({ level: 'waste', seq: c.seq, tool: c.name, message: `seq ${seen.get(key)} 와 같은 읽기를 반복` });
    else seen.set(key, c.seq);
  }
  // 낱개 쓰기가 연달아 3번 이상 — apply_edits 하나로 묶을 수 있었다
  let streak = [];
  const flush = () => {
    if (streak.length >= 3) findings.push({ level: 'waste', seq: streak[0].seq, tool: streak.map((c) => c.name).join(','), message: `낱개 쓰기 ${streak.length}번 연속 (seq ${streak[0].seq}–${streak[streak.length - 1].seq}) — apply_edits 로 묶을 수 있음` });
    streak = [];
  };
  for (const c of calls) {
    if (singleWrites.includes(c) && c.ok) streak.push(c);
    else if (isWrite(c.name)) flush();
  }
  flush();
  for (const run of sequentialReadRuns(calls)) {
    if (run.length >= 3) findings.push({ level: 'waste', seq: run[0].seq, tool: run.map((c) => c.name).join(','), message: `읽기 ${run.length}번 순차 호출 (seq ${run[0].seq}–${run[run.length - 1].seq}) — read_batch 로 묶을 수 있음` });
  }
  // 큰 결과
  for (const c of calls) {
    if (c.resultChars > 20_000) findings.push({ level: 'size', seq: c.seq, tool: c.name, message: `결과 ${c.resultChars.toLocaleString()}자` });
  }
  // 쓰기 뒤 경고
  for (const c of writes) {
    const warnings = c.result?.after?.warnings;
    if (Array.isArray(warnings) && warnings.length) findings.push({ level: 'warn', seq: c.seq, tool: c.name, message: `after.warnings: ${clip(warnings.join(' | '), 300)}` });
  }
  if (turn.error) findings.push({ level: 'error', seq: 0, tool: '(turn)', code: turn.error.code, message: clip(turn.error.message, 400) });

  return {
    toolCalls: calls.length,
    toolErrors: errors.length,
    errorCodes: byCode,
    byTool,
    writes: writes.length,
    resultChars: calls.reduce((n, c) => n + (c.resultChars ?? 0), 0),
    toolMs: calls.reduce((n, c) => n + (c.ms ?? 0), 0),
    durationMs: turn.durationMs,
    usage: turn.usage ?? null,
    findings,
  };
}

export function renderAudit(record) {
  const lines = [`# ${record.id}`, '', `- 문서: ${record.doc}`, `- 모드: ${record.mode} · 모델: ${record.model}`, `- 걸린 시간: ${Math.round((record.durationMs ?? 0) / 1000)}s`];
  if (record.error) lines.push('', '## 실행 오류', '```', record.error, '```');
  if (record.checks?.length) {
    lines.push('', '## 결과 검사');
    for (const c of record.checks) lines.push(`- ${c.pass ? '✔' : '✖'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  }
  if (record.pendingReview !== undefined) lines.push('', `검토 대기 변경: ${record.pendingReview} · 쪽 수: ${record.pageCount}`);
  let turnNo = 0;
  for (const turn of record.turns ?? []) {
    if (turn.review) { lines.push('', `## 검토: ${turn.review} (${turn.clicked ? '눌림' : '단추 없음'})`); continue; }
    turnNo += 1;
    const audit = record.audit?.[turnNo - 1];
    lines.push('', `## 턴 ${turnNo}`, '', `> ${String(turn.prompt).replace(/\n/g, '\n> ')}`, '');
    if (audit) {
      lines.push(`도구 ${audit.toolCalls}회 (오류 ${audit.toolErrors}) · 쓰기 ${audit.writes} · 결과 ${audit.resultChars.toLocaleString()}자 · 도구 시간 ${audit.toolMs}ms · 턴 ${Math.round((audit.durationMs ?? 0) / 1000)}s`
        + (audit.usage ? ` · 토큰 in ${audit.usage.inputTokens ?? '?'} / out ${audit.usage.outputTokens ?? '?'}${audit.usage.turns ? ` · 모델 요청 ${audit.usage.turns}` : ''}` : ''));
      if (audit.findings.length) {
        lines.push('', '### 신호');
        for (const f of audit.findings) lines.push(`- **${f.level}** #${f.seq} \`${f.tool}\`${f.code ? ` ${f.code}` : ''}: ${f.message}`);
      }
    }
    lines.push('', '### 타임라인');
    const calls = new Map((turn.toolCalls ?? []).map((c) => [c.seq, c]));
    for (const item of turn.timeline ?? []) {
      if (item.kind === 'text') {
        lines.push('', `**모델** (+${Math.round(item.t / 100) / 10}s): ${clip(item.text.trim(), 1500)}`);
      } else if (item.kind === 'tool') {
        const c = calls.get(item.seq);
        lines.push('', `**#${c.seq} ${c.name}** (+${Math.round(c.t / 100) / 10}s, ${c.ms}ms) ${c.ok ? '✔' : '✖'}`, '```json', compact(c.args, 1800), '```');
        lines.push(c.ok ? '→ 결과' : '→ **오류**', '```', compact(c.ok ? c.result : c.error, c.ok ? 1400 : 2400), '```');
      } else {
        lines.push('', `_${item.kind}_: ${compact({ ...item, t: undefined, kind: undefined }, 600)}`);
      }
    }
  }
  if (record.consoleErrors?.length) {
    lines.push('', '## 브라우저 콘솔 오류', ...record.consoleErrors.map((e) => `- ${clip(e, 300)}`));
  }
  return `${lines.join('\n')}\n`;
}

export function renderSummary(records, { tag, model }) {
  const lines = [`# 에이전트 평가 ${tag}`, '', `모델: ${model}`, '',
    '| 시나리오 | 결과 | 검사 | 도구 | 오류 | 오류 코드 | 결과 글자 | 턴 시간 | 모델 요청 | 토큰(in/out) |',
    '|---|---|---|---|---|---|---|---|---|---|'];
  const total = { calls: 0, errors: 0, chars: 0, ms: 0 };
  for (const r of records) {
    const a = (r.audit ?? []).reduce((acc, x) => ({
      toolCalls: acc.toolCalls + x.toolCalls, toolErrors: acc.toolErrors + x.toolErrors, resultChars: acc.resultChars + x.resultChars,
      durationMs: acc.durationMs + (x.durationMs ?? 0),
      codes: { ...acc.codes, ...Object.fromEntries(Object.entries(x.errorCodes).map(([k, v]) => [k, (acc.codes[k] ?? 0) + v])) },
      inTok: acc.inTok + (x.usage?.inputTokens ?? 0), outTok: acc.outTok + (x.usage?.outputTokens ?? 0), turns: acc.turns + (x.usage?.turns ?? 0),
    }), { toolCalls: 0, toolErrors: 0, resultChars: 0, durationMs: 0, codes: {}, inTok: 0, outTok: 0, turns: 0 });
    total.calls += a.toolCalls; total.errors += a.toolErrors; total.chars += a.resultChars; total.ms += a.durationMs;
    const passed = (r.checks ?? []).filter((c) => c.pass).length;
    const checks = r.checks?.length ? `${passed}/${r.checks.length}` : '–';
    const status = r.error ? '✖ 실행 오류' : r.checks?.some((c) => !c.pass) ? '△' : '✔';
    lines.push(`| ${r.id} | ${status} | ${checks} | ${a.toolCalls} | ${a.toolErrors} | ${Object.entries(a.codes).map(([k, v]) => `${k}×${v}`).join(' ') || '–'} | ${a.resultChars.toLocaleString()} | ${Math.round(a.durationMs / 1000)}s | ${a.turns || '–'} | ${a.inTok.toLocaleString()}/${a.outTok.toLocaleString()} |`);
  }
  lines.push('', `합계: 도구 ${total.calls}회, 오류 ${total.errors}회 (${total.calls ? Math.round((total.errors / total.calls) * 1000) / 10 : 0}%), 결과 ${total.chars.toLocaleString()}자, 턴 시간 ${Math.round(total.ms / 1000)}s`);
  const failedChecks = records.flatMap((r) => (r.checks ?? []).filter((c) => !c.pass).map((c) => `- ${r.id}: ${c.name}${c.detail ? ` — ${c.detail}` : ''}`));
  if (failedChecks.length) lines.push('', '## 실패한 검사', ...failedChecks);
  const signals = records.flatMap((r) => (r.audit ?? []).flatMap((a) => a.findings.map((f) => `- ${r.id} #${f.seq} \`${f.tool}\` **${f.level}**${f.code ? ` ${f.code}` : ''}: ${f.message}`)));
  if (signals.length) lines.push('', '## 신호', ...signals);
  return `${lines.join('\n')}\n`;
}

/** 줄 단위 간단 diff (LCS) — 구조 덤프 전후 비교용 */
export function textDiff(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  if (a.length * b.length > 4_000_000) return '(diff 생략 — 너무 큼)';
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`- ${a[i++]}`);
    else out.push(`+ ${b[j++]}`);
  }
  while (i < a.length) out.push(`- ${a[i++]}`);
  while (j < b.length) out.push(`+ ${b[j++]}`);
  return out.length ? out.join('\n') : '(변화 없음)';
}
