# tests/test_chat.py — chat prompt + SSE (Task 3).
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


def test_build_prompt_cites_sources():
    hits = [{"text": "photosynthesis facts", "pages": "3", "source": "bio.pdf"}]
    prompt = backend.build_prompt("what is x?", hits)
    assert "[bio.pdf p.3]" in prompt
    assert "Not in your sources" in prompt
    assert "what is x?" in prompt


def test_ask_stream_uses_k6(monkeypatch):
    seen = {}

    def fake_query(nid, q, k=6):
        seen.update(nid=nid, q=q, k=k)
        return [{"text": "t", "pages": "1", "source": "s"}]

    monkeypatch.setattr(backend, "query", fake_query)
    monkeypatch.setattr(backend, "llm_stream", lambda prompt: iter(["tok"]))
    assert list(backend.ask_stream("n1", "hello")) == ["tok"]
    assert seen["k"] == 6


def test_ask_stream_empty_hits_refuses_without_model(monkeypatch):
    calls = []

    monkeypatch.setattr(backend, "query", lambda nid, q, k=6: [])
    monkeypatch.setattr(backend, "indexed_count", lambda nid: 0)
    monkeypatch.setattr(
        backend, "llm_stream", lambda prompt: (_ for _ in ()).throw(AssertionError("model must not run"))
    )
    assert list(backend.ask_stream("n1", "hello")) == ["Not in your sources."]


def test_ask_stream_logs_hits_and_indexed(monkeypatch):
    import queue as _queue

    q = _queue.Queue()
    monkeypatch.setattr(backend, "_log_queue", q)
    monkeypatch.setattr(
        backend, "query", lambda nid, q_, k=6: [{"text": "t", "pages": "1", "source": "s"}]
    )
    monkeypatch.setattr(backend, "indexed_count", lambda nid: 42)
    monkeypatch.setattr(backend, "llm_stream", lambda prompt: iter(["tok"]))
    assert list(backend.ask_stream("n1", "hello world")) == ["tok"]
    assert q.get_nowait()["message"] == 'System: ask "hello world" (1 hits / 42 indexed)'


def test_chat_sse_done_and_saved(client, monkeypatch):
    db = backend.get_db()
    nid = backend.create_notebook(db, "nb")
    monkeypatch.setattr(
        backend, "ask_stream", lambda nid, q: iter(["hello ", "world"])
    )
    r = client.post(f"/api/notebooks/{nid}/chat", json={"query": "hi"})
    assert r.status_code == 200
    assert r.mimetype == "text/event-stream"
    body = r.get_data(as_text=True)
    assert f"data: {json.dumps({'token': 'hello '})}" in body
    assert "data: [DONE]" in body
    msgs = backend.list_messages(db, nid)
    assert [m["role"] for m in msgs] == ["user", "assistant"]
    assert msgs[1]["content"] == "hello world"


def test_chat_requires_query(client):
    db = backend.get_db()
    nid = backend.create_notebook(db, "nb")
    assert client.post(f"/api/notebooks/{nid}/chat", json={}).status_code == 422
