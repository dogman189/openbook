# tests/test_ingest.py — PDF limits + chunking (Task 2, Flask core).
import pytest

import backend
from backend import chunk_text, parse_pdf


def test_parse_pdf_limits_reject(tmp_path):
    p = tmp_path / "big.pdf"
    p.write_bytes(b"x" * (100 * 1024 * 1024 + 1))
    with pytest.raises(ValueError, match="100MB"):
        parse_pdf(str(p))


def test_parse_pdf_scanned_without_ocr_engine_rejects(monkeypatch, tmp_path):
    f = tmp_path / "s.pdf"
    f.write_bytes(b"%PDF tiny")

    class _Page:
        def extract_text(self):
            return "x"

    class _Reader:
        def __init__(self, path):
            self.pages = [_Page()]

    monkeypatch.setattr(backend, "PdfReader", _Reader)
    monkeypatch.setattr(backend, "_ocr_available", lambda: False)
    with pytest.raises(ValueError, match="OCR unavailable"):
        parse_pdf(str(f))


def test_parse_pdf_ocrs_only_empty_pages(monkeypatch, tmp_path):
    f = tmp_path / "mix.pdf"
    f.write_bytes(b"%PDF tiny")

    class _Page:
        def __init__(self, text):
            self._text = text

        def extract_text(self):
            return self._text

    class _Reader:
        def __init__(self, path):
            # Page 1 holds little but enough embedded text to keep (>50
            # chars, so no OCR); page 2 is image-only. Total stays under
            # the 200-char floor so the OCR path must run to pass.
            self.pages = [_Page("selectable " * 6), _Page("")]

    monkeypatch.setattr(backend, "PdfReader", _Reader)
    monkeypatch.setattr(backend, "_ocr_available", lambda: True)
    monkeypatch.setattr(
        backend, "_raster_pages", lambda path, pages: [(pg, b"arr") for pg in pages]
    )
    seen = []

    def _fake_ocr(arr):
        seen.append(arr)
        return "ocred text " * 50

    monkeypatch.setattr(backend, "_ocr_page", _fake_ocr)
    out = parse_pdf(str(f))
    assert out[0]["text"].startswith("selectable")
    assert out[1]["text"].startswith("ocred text")
    assert seen == [b"arr"]


def test_parse_pdf_too_many_pages_rejects(monkeypatch, tmp_path):
    f = tmp_path / "long.pdf"
    f.write_bytes(b"%PDF tiny")

    class _Reader:
        pages = [object()] * 1001

        def __init__(self, path):
            pass

    monkeypatch.setattr("backend.PdfReader", _Reader)
    with pytest.raises(ValueError, match="1000 pages"):
        parse_pdf(str(f))


def test_chunk_text_windows_and_page_refs():
    pages = [
        {"page": 1, "text": " ".join(f"a{i}" for i in range(500))},
        {"page": 2, "text": " ".join(f"b{i}" for i in range(500))},
    ]
    chunks = chunk_text(pages, size=800, overlap=100)
    assert len(chunks) == 2
    assert chunks[0]["chunk_id"] == 0
    assert chunks[0]["pages"] == [1, 2]
    assert chunks[1]["pages"] == [2]
    # overlap: last 100 words of chunk 0 reappear at the start of chunk 1
    assert chunks[1]["text"].split()[:100] == chunks[0]["text"].split()[700:800]
