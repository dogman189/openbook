# tests/test_summary.py — map/reduce summary + routes (Task 3).
import json

import pytest

import backend


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(backend, "_DB", backend.init_db(str(tmp_path / "api.db")))
    monkeypatch.setattr(backend, "CONFIG_PATH", tmp_path / "config.json")
    monkeypatch.setattr(backend, "UPLOADS_DIR", tmp_path / "uploads")
    backend.app.config["TESTING"] = True
    return backend.app.test_client()


def test_parse_sections_caps():
    terms = "\n".join(f"- term{i}" for i in range(20))
    heads = "\n".join(f"- h{i}" for i in range(10))
    text = f"SUMMARY: short prose\nKEY TERMS:\n{terms}\nOUTLINE:\n{heads}"
    summary, key_terms, outline = backend._parse_sections(text)
    assert summary == "short prose"
    assert len(key_terms) == 8
    assert len(outline) == 6


def test_summarize_map_reduce(monkeypatch):
    calls = []

    def fake_llm(prompt, max_new_tokens=512):
        calls.append((prompt, max_new_tokens))
        if max_new_tokens == 150:
            return "bullet one here"
        return "SUMMARY: combined prose\nKEY TERMS:\n- alpha\nOUTLINE:\n- part one"

    monkeypatch.setattr(backend, "llm_generate", fake_llm)
    chunks = [{"text": f"chunk {i} material", "pages": [1]} for i in range(10)]
    out = backend.summarize(chunks)
    assert [m for _, m in calls].count(150) == 8  # only chunks[:8] mapped
    assert out["summary"] == "combined prose"
    assert out["key_terms"] == ["alpha"]
    assert out["outline"] == ["part one"]


def test_summary_route_uses_k12_and_saves(client, monkeypatch):
    db = backend.get_db()
    nid = backend.create_notebook(db, "nb")
    seen = {}

    def fake_query(nid, q, k=6):
        seen["k"] = k
        return [{"text": "material", "pages": "1", "source": "s.pdf"}]

    monkeypatch.setattr(backend, "query", fake_query)
    monkeypatch.setattr(
        backend,
        "summarize",
        lambda chunks: {"summary": "s", "key_terms": [], "outline": []},
    )
    r = client.post(f"/api/notebooks/{nid}/summary", json={"sourceIds": ["a"]})
    assert r.status_code == 200
    assert seen["k"] == 12
    assert r.get_json()["summary"] == "s"
    rows = backend.list_summaries(db, nid)
    assert len(rows) == 1
    assert json.loads(rows[0]["source_ids_json"]) == ["a"]


def test_summaries_list(client):
    db = backend.get_db()
    nid = backend.create_notebook(db, "nb")
    backend.save_summary(db, nid, "[]", "{}")
    assert len(client.get(f"/api/notebooks/{nid}/summaries").get_json()) == 1
