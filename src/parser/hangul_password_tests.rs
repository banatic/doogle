//! 한글 2024 형식(EncryptVersion 0, DES envelope) HWP 암호 문서 읽기·쓰기 검증.
//!
//! fixture 는 한글 2024(13.0)가 COM 으로 저장한 실제 산출물이다
//! (`tests/fixtures/hwp_password/`).
//! - `hangul2024_plain.hwp`: 암호 없는 원본
//! - `hangul2024_abc123.hwp`: 같은 문서를 암호 `abc123` 으로 저장
//! - `hangul2024_image_korean.hwp`: NoCompress PNG 가 든 문서를 암호 `pw한글` 로 저장

use super::*;
use crate::password_crypto::{is_hwp5_des_stream, open_hwp5_des_stream};

const PLAIN: &[u8] = include_bytes!("../../tests/fixtures/hwp_password/hangul2024_plain.hwp");
const ABC123: &[u8] = include_bytes!("../../tests/fixtures/hwp_password/hangul2024_abc123.hwp");
const IMAGE_KOREAN: &[u8] =
    include_bytes!("../../tests/fixtures/hwp_password/hangul2024_image_korean.hwp");

fn text(doc: &Document) -> Vec<String> {
    doc.sections
        .iter()
        .flat_map(|section| section.paragraphs.iter().map(|p| p.text.clone()))
        .collect()
}

fn raw_stream(bytes: &[u8], path: &str) -> Vec<u8> {
    cfb_reader::CfbReader::open(bytes)
        .expect("CFB")
        .read_stream_raw(path)
        .unwrap_or_else(|_| panic!("stream 없음: {path}"))
}

fn protected_streams(bytes: &[u8]) -> Vec<String> {
    cfb_reader::CfbReader::open(bytes)
        .expect("CFB")
        .list_streams()
        .into_iter()
        .map(|path| format!("/{}", path.trim_start_matches('/')))
        .filter(|path| {
            path == "/DocInfo"
                || path.starts_with("/BodyText/")
                || path.starts_with("/ViewText/")
                || path.starts_with("/BinData/")
                || path.starts_with("/Scripts/")
        })
        .collect()
}

#[test]
fn opens_hangul_password_document() {
    let plain = parse_document(PLAIN).expect("평문 fixture");
    assert!(matches!(
        parse_document(ABC123),
        Err(ParseError::EncryptedDocument)
    ));
    for wrong in [b"abc124".as_slice(), b"", b"ABC123"] {
        assert!(
            matches!(
                parse_document_with_password(ABC123, wrong),
                Err(ParseError::CryptoError(crypto::CryptoError::WrongPassword))
            ),
            "틀린 암호 {wrong:?} 는 거부해야 한다"
        );
    }

    let opened = parse_document_with_password(ABC123, b"abc123").expect("한글 암호 문서 열기");
    assert!(opened.header.encrypted);
    assert_eq!(text(&opened), text(&plain));
    assert!(text(&opened)
        .iter()
        .any(|line| line.contains("hello password")));
    // 256바이트 채움 영역을 걷어낸 DocInfo 는 평문 문서와 같아야 한다.
    assert_eq!(opened.doc_info.raw_stream, plain.doc_info.raw_stream);
    assert_eq!(
        opened.doc_properties.section_count,
        plain.doc_properties.section_count
    );
}

#[test]
fn opens_hangul_password_document_with_korean_password_and_image() {
    let opened = parse_document_with_password(IMAGE_KOREAN, "pw한글".as_bytes())
        .expect("한글 암호 문서(그림) 열기");
    // BIN_DATA 속성은 NoCompress 지만 envelope 안에서는 deflate 되어 있다.
    let image = opened
        .bin_data_content
        .first()
        .expect("그림 BinData")
        .data
        .load();
    assert_eq!(&image[..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(image.len(), 1047);
    assert!(matches!(
        parse_document_with_password(IMAGE_KOREAN, b"pw"),
        Err(ParseError::CryptoError(crypto::CryptoError::WrongPassword))
    ));
}

#[test]
fn saves_password_document_in_hangul_format() {
    let plain = parse_document(PLAIN).expect("평문 fixture");
    let saved =
        crate::serializer::serialize_hwp_with_password(&plain, b"abc123").expect("암호 저장");

    // FileHeader 는 한글 산출물과 바이트가 같다 (flags 0x3, EncryptVersion 0).
    assert_eq!(
        raw_stream(&saved, "/FileHeader"),
        raw_stream(ABC123, "/FileHeader")
    );
    // 한글처럼 미리보기는 쓰지 않고, 암호 대상 stream 은 모두 DES envelope 이다.
    let mut saved_cfb = cfb_reader::CfbReader::open(&saved).expect("저장 CFB");
    assert!(!saved_cfb.has_stream("/PrvText"));
    assert!(!saved_cfb.has_stream("/PrvImage"));
    assert_eq!(protected_streams(&saved), protected_streams(ABC123));
    for path in protected_streams(&saved) {
        let stream = saved_cfb.read_stream_raw(&path).unwrap();
        assert!(
            is_hwp5_des_stream(&stream),
            "{path} 는 DES envelope 이어야 한다"
        );
        assert!(open_hwp5_des_stream(&stream, b"abc123").is_ok(), "{path}");
        assert!(open_hwp5_des_stream(&stream, b"abc124").is_err(), "{path}");
    }
    // 원본 deflate 를 그대로 감싸는 stream 은 한글 산출물과 바이트까지 같다.
    for path in ["/Scripts/JScriptVersion", "/Scripts/DefaultJScript"] {
        assert_eq!(raw_stream(&saved, path), raw_stream(ABC123, path), "{path}");
    }
    // DOCUMENT_PROPERTIES 는 256바이트 채움 영역만큼 길어진다.
    let doc_info =
        crypto::decrypt_password_protected(&raw_stream(&saved, "/DocInfo"), b"abc123", true)
            .expect("DocInfo 복호화");
    let first = record::Record::read_all(&doc_info).expect("레코드")[0].clone();
    assert_eq!(first.tag_id, tags::HWPTAG_DOCUMENT_PROPERTIES);
    assert_eq!(first.data.len(), 256 + 26);

    assert!(matches!(
        parse_document(&saved),
        Err(ParseError::EncryptedDocument)
    ));
    assert!(matches!(
        parse_document_with_password(&saved, b"wrong"),
        Err(ParseError::CryptoError(crypto::CryptoError::WrongPassword))
    ));
    let reopened = parse_document_with_password(&saved, b"abc123").expect("저장본 다시 열기");
    assert_eq!(text(&reopened), text(&plain));
    assert_eq!(reopened.doc_info.raw_stream, plain.doc_info.raw_stream);
}

#[test]
fn resaves_hangul_password_document_with_image() {
    let password = "pw한글".as_bytes();
    let opened = parse_document_with_password(IMAGE_KOREAN, password).expect("열기");
    let saved = crate::serializer::serialize_hwp_with_password(&opened, b"new-pw").expect("저장");
    for path in protected_streams(&saved) {
        assert!(is_hwp5_des_stream(&raw_stream(&saved, &path)), "{path}");
    }
    assert!(parse_document_with_password(&saved, password).is_err());
    let reopened = parse_document_with_password(&saved, b"new-pw").expect("다시 열기");
    assert_eq!(text(&reopened), text(&opened));
    assert_eq!(
        reopened.bin_data_content[0].data.load(),
        opened.bin_data_content[0].data.load()
    );

    // 암호 없이 저장하면 일반 문서로 돌아오고 채움 영역이 남지 않는다.
    let unprotected = crate::serializer::serialize_document(&opened).expect("암호 없이 저장");
    let reparsed = parse_document(&unprotected).expect("암호 없이 다시 열기");
    assert!(!reparsed.header.encrypted);
    assert_eq!(text(&reparsed), text(&opened));
    assert_eq!(
        reparsed.bin_data_content[0].data.load(),
        opened.bin_data_content[0].data.load()
    );
}

#[test]
fn saves_uncompressed_document_with_password() {
    let mut plain = parse_document(PLAIN).expect("평문 fixture");
    plain.header.compressed = false;
    plain.header.flags &= !0x01;
    if let Some(raw) = plain.header.raw_data.as_mut() {
        raw[36] &= !0x01;
    }
    let uncompressed = crate::serializer::serialize_document(&plain).expect("비압축 저장");
    let source = parse_document(&uncompressed).expect("비압축 다시 열기");
    assert!(!source.header.compressed);

    let saved =
        crate::serializer::serialize_hwp_with_password(&source, b"abc123").expect("암호 저장");
    assert_eq!(
        raw_stream(&saved, "/FileHeader")[36..48],
        raw_stream(ABC123, "/FileHeader")[36..48]
    );
    for path in protected_streams(&saved) {
        let stream = raw_stream(&saved, &path);
        assert!(open_hwp5_des_stream(&stream, b"abc123").is_ok(), "{path}");
    }
    let reopened = parse_document_with_password(&saved, b"abc123").expect("다시 열기");
    assert!(reopened.header.compressed);
    assert_eq!(text(&reopened), text(&source));
}

/// 평문 fixture 를 예전 두글 형식(EncryptVersion 4, AES-128 CFB-1)으로 암호화한다.
fn legacy_aes_document(password: &[u8], encrypt_version: u32) -> Vec<u8> {
    use std::io::{Read, Write};

    let mut compound =
        cfb::CompoundFile::open(std::io::Cursor::new(PLAIN.to_vec())).expect("cfb open");
    for path in protected_streams(PLAIN) {
        let mut raw = Vec::new();
        compound
            .open_stream(&path)
            .expect("암호화 대상 stream")
            .read_to_end(&mut raw)
            .unwrap();
        let encrypted = crypto::encrypt_password_stream_for_test(&raw, password);
        compound
            .create_stream(&path)
            .expect("암호문 stream")
            .write_all(&encrypted)
            .unwrap();
    }
    let mut header = Vec::new();
    compound
        .open_stream("/FileHeader")
        .expect("FileHeader")
        .read_to_end(&mut header)
        .unwrap();
    header[36] |= 0x02;
    header[44..48].copy_from_slice(&encrypt_version.to_le_bytes());
    compound
        .create_stream("/FileHeader")
        .expect("FileHeader 갱신")
        .write_all(&header)
        .unwrap();
    compound.into_inner().into_inner()
}

#[test]
fn still_opens_legacy_encrypt_version_4_document() {
    let plain = parse_document(PLAIN).expect("평문 fixture");
    let legacy = legacy_aes_document(b"abc123", crypto::SUPPORTED_PASSWORD_ENCRYPT_VERSION);
    assert!(matches!(
        parse_document(&legacy),
        Err(ParseError::EncryptedDocument)
    ));
    assert!(matches!(
        parse_document_with_password(&legacy, b"abc124"),
        Err(ParseError::CryptoError(crypto::CryptoError::WrongPassword))
    ));
    let opened = parse_document_with_password(&legacy, b"abc123").expect("예전 형식 열기");
    assert_eq!(text(&opened), text(&plain));
    assert_eq!(opened.doc_info.raw_stream, plain.doc_info.raw_stream);
}

#[test]
fn rejects_encrypt_versions_1_to_3() {
    for encrypt_version in 1..=3 {
        let legacy = legacy_aes_document(b"abc123", encrypt_version);
        assert!(matches!(
            parse_document_with_password(&legacy, b"abc123"),
            Err(ParseError::CryptoError(crypto::CryptoError::UnsupportedScheme { encrypt_version: found }))
                if found == encrypt_version
        ));
    }
}
