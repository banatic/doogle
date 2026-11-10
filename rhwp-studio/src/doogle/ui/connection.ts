/**
 * 에이전트 서비스 연결 상태 → 사용자 문구 (UI_AUDIT §3.4 연결 상태 카드).
 *
 * 입력은 두 갈래다.
 *  - `HubClient` 상태(`connecting | open | retrying | unavailable | stopped`)와 detail
 *  - 데스크탑이면 `doogle-desk/src/hub.rs` 의 `doogle://hub` 이벤트 — `failed{message}` ·
 *    `exited{restartInMs}` · `ready`. hub_info 실패도 같은 문자열을 detail 로 넘긴다.
 *
 * 화면 문구는 "무엇이 안 됐나(제목) + 왜(한 문장) + 다음 행동(단추)" 규칙을 따른다.
 * "agent hub" 같은 코드 용어는 쓰지 않는다 — 원문은 `raw` 로만 남겨 "자세히"에 둔다.
 * 이 파일은 DOM 을 만지지 않는다.
 */
import type { HubConnectionState } from '../hub-client.ts';

export interface DeskHubStatus {
  /** 마지막 `failed` 메시지 (ready 가 오면 비운다) */
  failure: string;
  /** `exited` 를 받은 뒤 다시 띄울 시각(ms). 없으면 0 */
  restartAt: number;
}

export interface ConnectionView {
  tone: 'quiet' | 'warn' | 'bad';
  title: string;
  body: string;
  /** 카운트다운 대상 시각(ms). 0 이면 없음 */
  retryAt: number;
  /** "다시 시도" 단추 */
  canRetry: boolean;
  /** "로그 열기" 단추 (데스크탑) */
  canOpenLog: boolean;
  /** 원문에서 찾은 로그 파일 경로 (로그 열기 실패 시 복사용) */
  logPath: string;
  help: { label: string; url: string } | null;
  /** 원문 — "자세히" */
  raw: string;
}

const NODE_DOWNLOAD = 'https://nodejs.org/ko/download';

/** 내부 용어를 사용자 용어로 ("agent hub 가" → "에이전트 서비스가") */
export function userWords(text: string): string {
  return text.replace(/agent hub\s?/gi, '에이전트 서비스').replace(/\bhub\b/gi, '에이전트 서비스');
}

function logPathOf(message: string): string {
  const match = /로그:\s*(.+)$/.exec(message.trim());
  return match ? match[1].trim() : '';
}

interface Cause {
  title: string;
  body: string;
  help?: { label: string; url: string };
  retry: boolean;
}

function classify(message: string, desk: boolean): Cause {
  const m = message.trim();
  const node = /Node\.js\s*(\d+)?/.exec(m);
  if (node) {
    return {
      title: '에이전트 서비스를 시작하지 못했습니다',
      body: `${node[1] ? `Node.js ${node[1]} 이상을` : 'Node.js 를'} 찾지 못했습니다. 설치한 뒤 다시 시도하세요.`,
      help: { label: 'Node.js 내려받기', url: NODE_DOWNLOAD },
      retry: true,
    };
  }
  if (/EADDRINUSE|address already in use|포트/i.test(m)) {
    return {
      title: '에이전트 서비스를 시작하지 못했습니다',
      body: '쓰려는 포트를 다른 프로그램이 이미 쓰고 있습니다. 그 프로그램을 끄거나 잠시 뒤 다시 시도하세요.',
      retry: true,
    };
  }
  if (/스크립트가 없습니다|script/i.test(m)) {
    return {
      title: '에이전트 서비스 파일이 없습니다',
      body: '설치가 손상됐을 수 있습니다. 두글을 다시 설치하세요.',
      retry: true,
    };
  }
  if (/준비되지 않았습니다|timed? ?out/i.test(m)) {
    return {
      title: '에이전트 서비스가 응답하지 않습니다',
      body: '시작은 했지만 제시간에 준비되지 않았습니다. 보안 프로그램이 막고 있을 수 있습니다. 로그를 확인한 뒤 다시 시도하세요.',
      retry: true,
    };
  }
  if (/시작하지 못했습니다/.test(m)) {
    return {
      title: '에이전트 서비스를 시작하지 못했습니다',
      body: 'Node.js 를 실행하지 못했습니다. 로그를 확인한 뒤 다시 시도하세요.',
      retry: true,
    };
  }
  if (/종료하는 중/.test(m)) {
    return { title: '앱을 종료하는 중입니다', body: '', retry: false };
  }
  if (/연결 정보가 없습니다/.test(m) && !desk) {
    return {
      title: '에이전트 서비스 주소가 없습니다',
      body: '브라우저 개발 모드에서는 주소에 ?hubPort=…&hubToken=… 을 붙여야 AI 기능을 쓸 수 있습니다.',
      retry: true,
    };
  }
  return {
    title: '에이전트 서비스를 쓸 수 없습니다',
    body: m ? userWords(m).replace(/\s*로그:\s*.+$/, '') : '잠시 뒤 다시 시도하세요.',
    retry: true,
  };
}

function secondsLeft(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

export function countdownText(at: number, now = Date.now()): string {
  const s = secondsLeft(at, now);
  return s <= 0 ? '지금 다시 연결하는 중…' : `${s}초 뒤 다시 연결합니다.`;
}

/** 지금 보일 연결 카드. 연결돼 있으면 null. */
export function describeConnection(
  state: HubConnectionState,
  detail: string,
  desk: DeskHubStatus,
  options: { isDesk: boolean; nextRetryAt: number },
): ConnectionView | null {
  if (state === 'open') return null;
  const base = { retryAt: 0, canRetry: false, canOpenLog: false, logPath: '', help: null, raw: '' };

  // 데스크 hub 가 실패했다고 알렸으면 그것이 가장 정확한 원인이다.
  const failure = desk.failure || (state === 'unavailable' ? detail : '');
  if (failure && state !== 'stopped') {
    const cause = classify(failure, options.isDesk);
    return {
      ...base,
      tone: 'bad',
      title: cause.title,
      body: cause.body,
      canRetry: cause.retry,
      canOpenLog: options.isDesk,
      logPath: logPathOf(failure),
      help: cause.help ?? null,
      raw: failure,
      retryAt: state === 'unavailable' ? options.nextRetryAt : 0,
    };
  }
  if (desk.restartAt && desk.restartAt > Date.now() - 1000) {
    return {
      ...base,
      tone: 'warn',
      title: '에이전트 서비스가 멈췄습니다',
      body: '',
      retryAt: desk.restartAt,
      canRetry: true,
      canOpenLog: options.isDesk,
    };
  }
  switch (state) {
    case 'connecting':
      return { ...base, tone: 'quiet', title: '에이전트 서비스에 연결하는 중…', body: '' };
    case 'retrying':
      return {
        ...base,
        tone: 'warn',
        title: '에이전트 서비스 연결이 끊겼습니다',
        body: '',
        retryAt: options.nextRetryAt,
        canRetry: true,
        raw: detail,
      };
    case 'stopped':
      return { ...base, tone: 'quiet', title: '에이전트 서비스 연결을 닫았습니다', body: '' };
    default:
      return { ...base, tone: 'bad', title: '에이전트 서비스를 쓸 수 없습니다', body: '', canRetry: true };
  }
}
