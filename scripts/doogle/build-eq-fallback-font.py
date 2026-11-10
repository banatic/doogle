#!/usr/bin/env python3
"""두글 수식 대체 글꼴(DoogleEqFallback.woff2)을 만든다.

한글(HWP) 수식은 한컴 수식 글꼴(HYhwpEQ · HancomEQN)의 사설 영역(PUA) 코드로 글자를 그린다
(src/renderer/equation/hancom_glyphs.rs 의 glyph()). 그 글꼴이 설치되지 않은 컴퓨터에서는
브라우저가 PUA 코드를 아무 글꼴로나 그려 x, b, 숫자가 한글 비슷한 글자나 네모로 보인다.

이 스크립트는 저장소에 이미 있는 Latin Modern Math(GUST Font License)에서 필요한 글리프만 골라,
같은 PUA 코드에 묶은 작은 글꼴을 만든다. 두글은 이 글꼴을 `HyhwpEQ` · `HancomEQN` 이름의
@font-face 로 걸되 `local()` 을 앞에 두어, 진짜 글꼴이 설치돼 있으면 그것을 쓴다
(rhwp-studio/src/doogle/theme/fonts.css).

  - 글자 자리(전진 폭)는 엔진이 한컴 메트릭으로 따로 정하므로, 여기서는 윤곽만 맞으면 된다.
  - 이탤릭 소문자 PUA 는 글리프 자체가 기울어 있다 → 수학 이탤릭 글리프(U+1D44E…)를 쓴다.
    이탤릭 대문자 PUA 는 엔진이 정체 글리프에 기울임 행렬을 건다 → 정체 대문자를 쓴다.
  - GUST Font License 는 고친 글꼴의 이름을 바꾸라고 한다 → "Doogle Eq Fallback".

실행:  python scripts/doogle/build-eq-fallback-font.py
필요:  fontTools, brotli (pip install fonttools brotli)
"""
import hashlib
import os
import sys

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SOURCE = os.path.join(ROOT, 'assets', 'fonts', 'LatinModernMath-Regular.woff2')
TARGET = os.path.join(ROOT, 'rhwp-studio', 'src', 'doogle', 'theme', 'fonts', 'DoogleEqFallback.woff2')
FAMILY = 'Doogle Eq Fallback'

GREEK_LOWER = 'αβγδεζηθικλμνξοπρστυφχψω'
GREEK_UPPER = 'ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ'


def math_italic(ch: str) -> int:
    """글자 → 수학 이탤릭 코드 (h 는 U+210E 플랑크 상수 자리에 있다)."""
    if ch == 'h':
        return 0x210E
    if 'a' <= ch <= 'z':
        return 0x1D44E + ord(ch) - ord('a')
    if 'α' <= ch <= 'ω':
        return 0x1D6FC + ord(ch) - ord('α')
    raise ValueError(ch)


def pua_map() -> dict:
    """한컴 수식 글꼴의 PUA 코드 → 대신 그릴 유니코드. hancom_glyphs.rs glyph() 와 같은 표."""
    out = {}
    for i in range(26):
        out[0xE0E5 + i] = math_italic(chr(ord('a') + i))  # 이탤릭 소문자 (글리프가 기울어 있다)
        out[0xE000 + i] = ord('A') + i                    # 이탤릭 대문자 (엔진이 기울인다)
    out[0xE03D] = ord('0')
    for d in range(1, 10):
        out[0xE033 + d] = ord('0') + d
    out.update({
        0xE048: ord('+'), 0xE046: 0x2212, 0xE047: ord('='), 0xE04F: ord(':'),
        0xE055: ord('<'), 0xE056: ord('>'), 0xE052: ord(','), 0xE044: ord('('), 0xE045: ord(')'),
        0xE067: 0x2211,       # ∑
        0xE050: ord("'"),     # 인용 작은따옴표
        0xE042: ord('%'),
    })
    for i, ch in enumerate(GREEK_LOWER):
        out[0xE09D + i] = math_italic(ch)
    for i, ch in enumerate(GREEK_UPPER):
        out[0xE085 + i] = ord(ch)
    return out


# PUA 가 아닌 코드로 그리는 글자 (정체 변수·연산자) — 같은 글꼴 이름으로 그려지므로 함께 싣는다.
PLAIN = (
    [chr(c) for c in range(0x20, 0x7F)]
    + list('×÷≤≥∴∵∏∑△⋅−±≠≈∞·')
    + list(GREEK_LOWER) + list(GREEK_UPPER)
)


def main() -> int:
    if not os.path.exists(SOURCE):
        print(f'원본 글꼴이 없습니다: {SOURCE}', file=sys.stderr)
        return 1
    mapping = pua_map()
    wanted = sorted(set(mapping.values()) | {ord(c) for c in PLAIN})

    options = subset.Options()
    options.layout_features = []       # 수식 조판은 엔진이 한다 — GSUB/GPOS/MATH 는 필요 없다
    options.drop_tables += ['MATH', 'GSUB', 'GPOS', 'GDEF', 'FFTM']
    options.name_IDs = [1, 2, 3, 4, 6]
    options.notdef_outline = True
    options.glyph_names = False
    options.hinting = False
    options.desubroutinize = True
    font = TTFont(SOURCE)
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=wanted)
    subsetter.subset(font)

    best = font.getBestCmap()
    missing = [hex(u) for u in wanted if u not in best]
    if missing:
        print(f'원본 글꼴에 없는 글자: {missing}', file=sys.stderr)
        return 1
    for table in font['cmap'].tables:
        if not table.isUnicode():
            continue
        for pua, target in mapping.items():
            if pua > 0xFFFF and table.format == 4:
                continue
            table.cmap[pua] = best[target]

    # 고친 글꼴은 이름을 바꾼다 (GUST Font License)
    for record in font['name'].names:
        if record.nameID in (1, 4):
            record.string = FAMILY
        elif record.nameID == 6:
            record.string = FAMILY.replace(' ', '')
        elif record.nameID == 3:
            record.string = f'{FAMILY}; derived from Latin Modern Math 1.959'
    if 'CFF ' in font:
        cff = font['CFF '].cff
        cff.fontNames = [FAMILY.replace(' ', '')]
        top = cff.topDictIndex[0]
        top.FullName = FAMILY
        top.FamilyName = FAMILY

    os.makedirs(os.path.dirname(TARGET), exist_ok=True)
    font.flavor = 'woff2'
    font.save(TARGET)
    data = open(TARGET, 'rb').read()
    print(f'{os.path.relpath(TARGET, ROOT)}  {len(data):,} 바이트  글리프 {len(font.getGlyphOrder())}개')
    print(f'SHA-256 {hashlib.sha256(data).hexdigest()}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
