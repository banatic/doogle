/**
 * 문서 묶음(DocHub) 참조 — 의존이 없는 작은 등록 자리.
 *
 * `doc-hub.ts` 는 엔진 모듈(`@/core/…`)을 값으로 가져온다. 단위 시험(node --test)이 읽는 두글 모듈
 * (narrow-fit 등)이 그 파일을 직접 가져오면 시험이 엔진까지 끌고 들어가 깨진다 — 그런 모듈은 여기서 hub 를 얻는다.
 */
import type { DocHub } from './doc-hub.ts';

let hub: DocHub | null = null;

export function registerDocHub(next: DocHub): void {
  hub = next;
}

/** 문서 탭이 켜져 있으면 hub, 아니면(비두글·embed·단위 시험) null */
export function getDocHub(): DocHub | null {
  return hub;
}
