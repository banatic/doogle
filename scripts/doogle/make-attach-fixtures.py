"""참고 파일(첨부) 시험용 견본 파일을 만든다.

    python scripts/doogle/make-attach-fixtures.py

만드는 것:
  rhwp-studio/src/doogle/agent/__tests__/fixtures/attach-sample.xlsx  (저장소에 넣는다 — 단위 시험이 읽는다)
  doogle-agent/eval/.fixtures/attach/*                                 (저장소 밖 — 실제 화면 탐침이 올린다)

필요한 것: openpyxl, PyMuPDF(fitz), Pillow. docx · pptx 는 표준 라이브러리 zipfile 로 직접 쓴다.
"""
import datetime
import io
import os
import zipfile

import fitz  # PyMuPDF
import openpyxl
from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
UNIT = os.path.join(ROOT, 'rhwp-studio', 'src', 'doogle', 'agent', '__tests__', 'fixtures')
EVAL = os.path.join(ROOT, 'doogle-agent', 'eval', '.fixtures', 'attach')
os.makedirs(UNIT, exist_ok=True)
os.makedirs(EVAL, exist_ok=True)


def xlsx(path):
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = '예산'
    ws.append(['항목', '금액', '집행일', '비율'])
    ws.append(['연수비', 150000, datetime.date(2026, 7, 20), 0.25])
    ws.append(['교재비', 32000.5, datetime.datetime(2026, 8, 14, 9, 30), 0.1 + 0.2])
    ws['D2'].number_format = '0%'
    people = wb.create_sheet('담당자')
    people.append(['이름', '부서', '비고'])
    people.append(['홍길동', '총무과'])
    people.append(['김철수', '교무부', '인수인계 & 확인 <필수>'])
    wb.create_sheet('빈 시트')
    wb.save(path)


def write_zip(path, entries):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, body in entries:
            z.writestr(name, body)


W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'


def docx(path):
    def p(text):
        return f'<w:p><w:r><w:t xml:space="preserve">{text}</w:t></w:r></w:p>'

    def tc(text):
        return f'<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>{p(text)}</w:tc>'

    body = ''.join([
        p('2026학년도 교원 자율연수 운영 계획'),
        p('1. 목적: 교원의 전문성 신장을 위한 자율연수 참여 지원'),
        p('2. 지원 한도: 1인당 연 150,000원'),
        '<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>'
        + f'<w:tr>{tc("연수 과정")}{tc("연수 기관")}</w:tr>'
        + f'<w:tr>{tc("AI 활용 수업 설계")}{tc("한빛교원연수원")}</w:tr>'
        + '</w:tbl>',
        p('3. 문의: 교무부 김철수 (내선 4321)'),
    ])
    write_zip(path, [
        ('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
        ('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
        ('word/document.xml', f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document {W_NS}><w:body>{body}<w:sectPr/></w:body></w:document>'),
    ])


def pptx(path):
    ns = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

    def slide(*lines):
        paras = ''.join(f'<a:p><a:r><a:rPr lang="ko-KR"/><a:t>{t}</a:t></a:r></a:p>' for t in lines)
        return f'<?xml version="1.0" encoding="UTF-8"?><p:sld {ns}><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/>{paras}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>'

    write_zip(path, [
        ('ppt/presentation.xml', f'<?xml version="1.0" encoding="UTF-8"?><p:presentation {ns}><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId1"/></p:sldIdLst></p:presentation>'),
        ('ppt/_rels/presentation.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="s" Target="slides/slide1.xml"/><Relationship Id="rId2" Type="s" Target="slides/slide2.xml"/></Relationships>'),
        ('ppt/slides/slide1.xml', slide('추진 일정', '7월: 연수 신청 · 8월: 연수 이수 · 9월: 정산')),
        ('ppt/slides/slide2.xml', slide('자율연수 설명회', '발표: 교무부장 박영희')),
    ])


def pdf_text(path):
    doc = fitz.open()
    for n, lines in enumerate([
        ['교원 자율연수비 지원 규정', '제1조(목적) 이 규정은 교원의 자율연수비 지원에 필요한 사항을 정한다.', '제2조(지원 한도) 지원 한도는 1인당 연 150,000원으로 한다.'],
        ['제3조(신청) 신청서는 연수 시작 7일 전까지 교무부에 제출한다.', '제4조(정산) 이수증과 영수증을 연수 종료 후 14일 안에 제출한다.'],
    ]):
        page = doc.new_page()
        y = 90
        for line in lines:
            page.insert_text((60, y), line, fontname='korea', fontsize=12)
            y += 28
        page.insert_text((280, 800), f'- {n + 1} -', fontname='helv', fontsize=9)
    doc.save(path)
    doc.close()


def picture(path, text, size=(1800, 1200), color=(31, 78, 121)):
    """글자가 든 그림 — 에이전트가 그림을 '보았는지' 확인할 표식(큰 글자)을 또렷하게 넣는다."""
    from PIL import ImageFont
    img = Image.new('RGB', size, (255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.rectangle([40, 40, size[0] - 40, size[1] - 40], outline=color, width=12)
    font = None
    for name in ('arialbd.ttf', 'arial.ttf', 'DejaVuSans-Bold.ttf'):
        try:
            font = ImageFont.truetype(name, size[0] // 8)
            break
        except OSError:
            continue
    if font is None:
        font = ImageFont.load_default()
    box = draw.textbbox((0, 0), text, font=font)
    draw.text(((size[0] - (box[2] - box[0])) // 2 - box[0], (size[1] - (box[3] - box[1])) // 2 - box[1]), text, fill=color, font=font)
    img.save(path)


def pdf_scanned(path):
    """글 층이 없는 PDF (스캔본 흉내) — 쪽마다 그림 한 장."""
    doc = fitz.open()
    for code in ['SCAN-7731', 'SCAN-7732']:
        buf = io.BytesIO()
        tmp = os.path.join(EVAL, '_scan.png')
        picture(tmp, code, size=(1240, 1754))
        with open(tmp, 'rb') as f:
            buf.write(f.read())
        os.remove(tmp)
        page = doc.new_page(width=595, height=842)
        page.insert_image(page.rect, stream=buf.getvalue())
    doc.save(path)
    doc.close()


xlsx(os.path.join(UNIT, 'attach-sample.xlsx'))
xlsx(os.path.join(EVAL, '예산.xlsx'))
docx(os.path.join(EVAL, '운영계획.docx'))
pptx(os.path.join(EVAL, '설명회.pptx'))
pdf_text(os.path.join(EVAL, '지원규정.pdf'))
pdf_scanned(os.path.join(EVAL, '스캔본.pdf'))
picture(os.path.join(EVAL, '직인.png'), 'SEAL-4096')
with open(os.path.join(EVAL, '신청자.txt'), 'w', encoding='utf-8', newline='\n') as f:
    f.write('소속: 한빛고등학교\n직위: 수석교사\n성명: 이서연\n연수기관: 한빛교원연수원\n연수과정: AI 활용 수업 설계\n연수기간: 2026.7.20.~8.14.\n이수시간: 30시간\n소요금액: 180,000원\n신청금액: 150,000원\n은행: 한빛은행\n계좌번호: 110-234-567890 (예금주: 이서연)\n')
with open(os.path.join(EVAL, '복학생 정보.txt'), 'w', encoding='utf-8', newline='\n') as f:
    f.write('복학 신청자 정보\n성명: 박지우\n학번: 20221187\n대학: 공과대학\n학과: 전자공학과\n휴대 전화: 010-5555-0142\ne-Mail: jiwoo.park@example.com\n현주소: 서울특별시 성북구 한빛로 12길 34\n복학 학기: 2027학년도 1학기\n작성일: 2026년 11월 12일\n')
with open(os.path.join(EVAL, '명단.csv'), 'w', encoding='euc-kr', newline='') as f:
    f.write('이름,부서,내선\r\n홍길동,총무과,1234\r\n김철수,교무부,4321\r\n')
with open(os.path.join(EVAL, '옛문서.doc'), 'wb') as f:
    f.write(b'\xd0\xcf\x11\xe0' + b'\x00' * 600)
with open(os.path.join(EVAL, '빈 파일.txt'), 'wb') as f:
    pass
print('made', sorted(os.listdir(EVAL)), 'and', os.path.join(UNIT, 'attach-sample.xlsx'))
