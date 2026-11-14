#!/usr/bin/env python3
"""두글 아이콘을 원본 그림 한 장에서 모두 다시 만든다.

    python doogle-desk/scripts/make-icons.py            (Pillow 필요, Windows 글꼴 Segoe UI Bold 사용)

원본:  doogle-desk/icons/source/doogle-icon-original.png   (바깥이 투명한 둥근 사각형 아이콘)
만드는 것
  doogle-desk/icons/source/app-1024.png     여백을 잘라 정사각형에 맞춘 마스터
  doogle-desk/icons/{32x32,128x128,128x128@2x,icon}.png · icon.ico · icon.icns   앱 아이콘 (`tauri icon`)
  doogle-desk/icons/hwp.ico · hwpx.ico      파일 형식 아이콘 (오른쪽 아래 확장자 딱지, 크기마다 따로 그린다)
  rhwp-studio/public/doogle/{favicon.ico,icon-256.png,icon-512.png}   웹 파비콘·정보 창 로고

파일 형식 아이콘은 실행 파일에 리소스로 들어간다(build.rs).
"""
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

DESK = Path(__file__).resolve().parent.parent
ICONS = DESK / "icons"
SOURCE = ICONS / "source" / "doogle-icon-original.png"
MASTER = ICONS / "source" / "app-1024.png"
WEB = DESK.parent / "rhwp-studio" / "public" / "doogle"

MASTER_SIZE = 1024
MARGIN = 20  # 마스터 가장자리 여백(px) — 이전 아이콘과 같은 비율
FILE_ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]
BADGES = {
    "hwp": ("HWP", (16, 42, 110)),  # 남색
    "hwpx": ("HWPX", (232, 89, 12)),  # 주황 — 작은 크기에서 색으로도 구별된다
}
WHITE = (255, 255, 255, 255)

# 작은 크기용 점 글꼴. 글꼴 파일을 줄여 그리면 16·32px 에서 뭉개진다.
FONT_3X5 = {
    "H": ["101", "101", "111", "101", "101"],
    "W": ["101", "101", "111", "111", "101"],
    "P": ["110", "101", "110", "100", "100"],
    "X": ["101", "101", "010", "101", "101"],
}
FONT_5X7 = {
    "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
    "W": ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
    "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
    "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
}


def make_master() -> Image.Image:
    src = Image.open(SOURCE).convert("RGBA")
    alpha = src.getchannel("A")
    box = alpha.point(lambda v: 255 if v > 8 else 0).getbbox()
    left, top, right, bottom = box
    side = max(right - left, bottom - top)
    cx, cy = (left + right) / 2, (top + bottom) / 2
    square = src.crop((round(cx - side / 2), round(cy - side / 2), round(cx + side / 2), round(cy + side / 2)))
    inner = MASTER_SIZE - 2 * MARGIN
    square = square.resize((inner, inner), Image.LANCZOS)
    # 안쪽의 거의 불투명한 픽셀(254)은 완전히 불투명하게, 바깥 잡티는 완전히 투명하게
    a = square.getchannel("A").point(lambda v: 255 if v >= 250 else (0 if v <= 6 else v))
    square.putalpha(a)
    master = Image.new("RGBA", (MASTER_SIZE, MASTER_SIZE), (0, 0, 0, 0))
    master.alpha_composite(square, (MARGIN, MARGIN))
    return master


def pixel_text_width(text: str, font: dict, gap: int) -> int:
    return sum(len(font[ch][0]) for ch in text) + gap * (len(text) - 1)


def draw_pixel_text(img: Image.Image, text: str, font: dict, x: int, y: int, gap: int, scale: int = 1) -> None:
    px = img.load()
    for ch in text:
        glyph = font[ch]
        for row, bits in enumerate(glyph):
            for col, bit in enumerate(bits):
                if bit == "1":
                    for dy in range(scale):
                        for dx in range(scale):
                            px[x + col * scale + dx, y + row * scale + dy] = WHITE
        x += (len(glyph[0]) + gap) * scale


def small_file_icon(base: Image.Image, size: int, text: str, color: tuple) -> Image.Image:
    """16~40px: 점 글꼴 딱지를 픽셀 단위로 맞춰 그린다."""
    img = base.resize((size, size), Image.LANCZOS)
    if size < 24:
        font, gap = FONT_3X5, 1
    else:
        font, gap = FONT_5X7, (2 if size >= 40 and len(text) == 3 else 1)
    glyph_h = len(font["H"])
    text_w = pixel_text_width(text, font, gap)
    pad_x = 1 if text_w + 4 > size else 2
    pad_y = 1 if size < 24 else 2
    badge_w = min(size, text_w + 2 * pad_x)
    badge_h = glyph_h + 2 * pad_y
    x0, y0 = size - badge_w, size - badge_h
    draw = ImageDraw.Draw(img)
    # 딱지가 아이콘의 파란 바탕에 묻히지 않게 흰 테두리 1px 을 먼저 깐다
    draw.rectangle((x0 - 1, y0 - 1, size - 1, size - 1), fill=WHITE)
    draw.rectangle((x0, y0, size - 1, size - 1), fill=color + (255,))
    draw_pixel_text(img, text, font, x0 + (badge_w - text_w) // 2, y0 + pad_y, gap)
    return img


def large_file_icon(base: Image.Image, size: int, text: str, color: tuple) -> Image.Image:
    """48px 이상: 둥근 딱지 + 굵은 글꼴. 4배로 그려 줄인다."""
    ss = 4
    s = size * ss
    img = base.resize((s, s), Image.LANCZOS)
    badge_h = round(s * (0.34 if size < 96 else 0.29))  # 큰 크기에서는 그림을 덜 가린다
    font = ImageFont.truetype("segoeuib.ttf", round(badge_h * 0.74))
    draw = ImageDraw.Draw(img)
    spacing = round(badge_h * 0.03)
    widths = [draw.textlength(ch, font=font) for ch in text]
    text_w = sum(widths) + spacing * (len(text) - 1)
    badge_w = round(text_w + badge_h * 0.56)
    ring = max(ss, round(s * 0.022))
    radius = round(badge_h * 0.26)
    x1, y1 = s - 1, s - 1
    x0, y0 = x1 - badge_w, y1 - badge_h
    draw.rounded_rectangle((x0 - ring, y0 - ring, x1, y1), radius=radius + ring, fill=WHITE)
    draw.rounded_rectangle((x0, y0, x1 - ring, y1 - ring), radius=radius, fill=color + (255,))
    cx = x0 + (badge_w - ring - text_w) / 2
    cy = y0 + (badge_h - ring) / 2
    for ch, w in zip(text, widths):
        draw.text((cx, cy), ch, font=font, fill=WHITE, anchor="lm")
        cx += w + spacing
    return img.resize((size, size), Image.LANCZOS)


def file_icon(base: Image.Image, size: int, text: str, color: tuple) -> Image.Image:
    return small_file_icon(base, size, text, color) if size <= 40 else large_file_icon(base, size, text, color)


def save_ico(path: Path, images: list) -> None:
    images = sorted(images, key=lambda im: im.width, reverse=True)
    images[0].save(path, format="ICO", sizes=[(im.width, im.height) for im in images], append_images=images[1:])


def copy_retry(src: Path, dst: Path) -> None:
    """보안 소프트웨어가 방금 쓴 파일을 검사하는 동안에는 덮어쓰기가 잠깐 막힌다 — 몇 번 다시 해 본다."""
    for attempt in range(20):
        try:
            shutil.copyfile(src, dst)
            return
        except OSError:
            if attempt == 19:
                raise
            time.sleep(0.5)


def run_tauri_icon(master: Path, out: Path) -> None:
    cli = DESK / "node_modules" / ".bin" / ("tauri.cmd" if sys.platform == "win32" else "tauri")
    subprocess.run([str(cli), "icon", str(master), "-o", str(out)], cwd=DESK, check=True)


def main() -> None:
    master = make_master()
    master.save(MASTER, optimize=True)

    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp)
        run_tauri_icon(MASTER, out)
        for name in ["32x32.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.ico", "icon.icns"]:
            copy_retry(out / name, ICONS / name)

    for key, (text, color) in BADGES.items():
        save_ico(ICONS / f"{key}.ico", [file_icon(master, size, text, color) for size in FILE_ICON_SIZES])

    WEB.mkdir(parents=True, exist_ok=True)
    copy_retry(ICONS / "icon.ico", WEB / "favicon.ico")
    for size in (256, 512):
        master.resize((size, size), Image.LANCZOS).save(WEB / f"icon-{size}.png", optimize=True)
    print("icons regenerated:", ICONS)


if __name__ == "__main__":
    main()
