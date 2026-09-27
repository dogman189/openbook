# tests/test_ingest.py — PDF limits + chunking (Task 2, Flask core).
import pytest

from backend import chunk_text, parse_pdf


def test_parse_pdf_limits_reject(tmp_path):
    p = tmp_path / "big.pdf"
    p.write_bytes(b"x" * (100 * 1024 * 1024 + 1))
    with pytest.raises(ValueError, match="100MB"):
        parse_pdf(str(p))


def test_parse_pdf_scanned_rejects(monkeypatch, tmp_path):
    f = tmp_path / "s.pdf"
    f.write_bytes(b"%PDF tiny")

    class _Page:
        def extract_text(self):
            return "x"

    class _Reader:
        def __init__(self, path):
            self.pages = [_Page()]

    monkeypatch.setattr("backend.PdfReader", _Reader)
    with pytest.raises(ValueError, match="OCR not in v1"):
        parse_pdf(str(f))


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
